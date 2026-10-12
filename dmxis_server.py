#!/usr/bin/env python3
"""Serve the remote and expose read-only DMXIS OSC feedback on localhost."""

import argparse
import functools
import json
import math
import os
from pathlib import Path
import re
import socket
import struct
import threading
import time
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


CHANNEL_COUNT = 512
CHANNEL_ADDRESS = re.compile(r"/dmxis/ch/([1-9][0-9]{0,2})\Z")
LOOPBACK = "127.0.0.1"


class OSCDecodeError(ValueError):
    """An incomplete or invalid OSC packet."""


def _read_string(packet, offset):
    end = packet.find(b"\0", offset)
    if end < 0:
        raise OSCDecodeError("Unterminated OSC string")
    next_offset = (end + 4) & ~3
    if next_offset > len(packet) or any(packet[end:next_offset]):
        raise OSCDecodeError("Invalid OSC string padding")
    try:
        value = packet[offset:end].decode("utf-8")
    except UnicodeDecodeError as exc:
        raise OSCDecodeError("Invalid OSC string encoding") from exc
    return value, next_offset


def decode_osc(packet, depth=0):
    """Return (address, arguments) messages, including nested bundles.

    DMXIS mixes numeric channel values and string labels in feedback bundles.
    Unknown addresses are ignored after the complete bundle has been decoded.
    """
    if not packet or len(packet) % 4 or depth > 16:
        raise OSCDecodeError("Invalid OSC packet size or nesting")
    if packet.startswith(b"#bundle\0"):
        if len(packet) < 16:
            raise OSCDecodeError("Incomplete OSC bundle")
        messages = []
        offset = 16  # The feedback is a live snapshot; bundle timetags are unused.
        while offset < len(packet):
            if offset + 4 > len(packet):
                raise OSCDecodeError("Missing OSC bundle element size")
            size = struct.unpack_from(">i", packet, offset)[0]
            offset += 4
            if size <= 0 or size % 4 or offset + size > len(packet):
                raise OSCDecodeError("Invalid OSC bundle element size")
            messages.extend(decode_osc(packet[offset:offset + size], depth + 1))
            offset += size
        return messages

    address, offset = _read_string(packet, 0)
    if not address.startswith("/"):
        raise OSCDecodeError("Invalid OSC address")
    tags, offset = _read_string(packet, offset)
    if not tags.startswith(","):
        raise OSCDecodeError("Missing OSC type tags")
    arguments = []
    for tag in tags[1:]:
        if tag == "s":
            value, offset = _read_string(packet, offset)
            arguments.append(value)
            continue
        if tag not in ("f", "i") or offset + 4 > len(packet):
            raise OSCDecodeError("Unsupported or incomplete OSC argument")
        arguments.append(struct.unpack_from(">" + tag, packet, offset)[0])
        offset += 4
    if offset != len(packet):
        raise OSCDecodeError("Unexpected bytes after OSC message")
    return [(address, arguments)]


class DMXISStatus:
    """Thread-safe feedback cache; channels remain unknown until received."""

    def __init__(self, stale_after=3.0):
        self.stale_after = stale_after
        self._instance_id = uuid.uuid4().hex
        self._lock = threading.Lock()
        self._values = [None] * CHANNEL_COUNT
        self._updated_at = [0] * CHANNEL_COUNT
        self._updated_ns = [0] * CHANNEL_COUNT
        self._base_values = [None] * CHANNEL_COUNT
        self._base_updated_at = [0] * CHANNEL_COUNT
        self._base_updated_ns = [0] * CHANNEL_COUNT
        self._modulated = [None] * CHANNEL_COUNT
        self._snapshot_at = 0
        self._snapshot_ns = 0
        self._revision = 0
        self._received_at = 0
        self._last_seen = None
        self._snapshot_signature = None

    def receive(self, packet):
        """Accept one UDP datagram. Invalid/unrelated feedback is ignored."""
        try:
            messages = decode_osc(packet)
        except OSCDecodeError:
            return False
        changes = []
        heartbeat = False
        for address, arguments in messages:
            if address == "/dmxis/ticktock":
                if not arguments or (len(arguments) == 1
                                     and isinstance(arguments[0], (int, float))
                                     and math.isfinite(arguments[0])):
                    heartbeat = True
                continue
            match = CHANNEL_ADDRESS.fullmatch(address)
            if not match or len(arguments) != 1:
                continue
            channel = int(match.group(1))
            value = arguments[0]
            if (channel > CHANNEL_COUNT or not isinstance(value, (int, float))
                    or not math.isfinite(value) or not 0 <= value <= 1):
                continue
            # Match Math.round(value * 127), including midpoint values.
            changes.append((channel - 1, math.floor(value * 127 + 0.5)))
        if not changes and not heartbeat:
            return False
        with self._lock:
            received_ns = int(time.time() * 1_000_000_000)
            received_at = received_ns // 1_000_000
            self._last_seen = time.monotonic()
            self._received_at = received_at
            for index, value in changes:
                self._values[index] = value
                self._updated_at[index] = received_at
                self._updated_ns[index] = received_ns
                # OSC reports modulated output, so it is a safe flash baseline
                # only when a macro has confirmed that this channel has no effect.
                if self._modulated[index] is False:
                    self._base_values[index] = value
                    self._base_updated_at[index] = received_at
                    self._base_updated_ns[index] = received_ns
            if changes:
                self._revision += 1
        return True

    def load_snapshot(self, filename):
        """Import fresh base faders and effect flags, preserving OSC output.

        A DMXIS macro writes this file atomically. Its modification time is the
        capture time, so old files cannot masquerade as live feedback.
        """
        try:
            with Path(filename).open("r", encoding="utf-8") as source:
                stat = os.fstat(source.fileno())
                signature = (stat.st_dev, stat.st_ino, stat.st_mtime_ns)
                with self._lock:
                    if signature == self._snapshot_signature:
                        return False
                    self._snapshot_signature = signature
                age = time.time() - stat.st_mtime
                if not 0 <= age < self.stale_after or stat.st_size > 65536:
                    return False
                data = json.load(source)
        except (OSError, UnicodeError, ValueError, RecursionError):
            return False
        if not isinstance(data, dict) or data.get("source") != "dmxis-macro":
            return False
        values = data.get("values")
        if (not isinstance(values, list) or len(values) != CHANNEL_COUNT
                or any(type(value) is not int or not 0 <= value <= 255 for value in values)):
            return False
        if "modulated" not in data:
            # Old macro snapshots do not prove which outputs equal their base.
            modulated = [True] * CHANNEL_COUNT
        else:
            modulated = data["modulated"]
            if (not isinstance(modulated, list) or len(modulated) != CHANNEL_COUNT
                    or any(type(value) is not bool for value in modulated)):
                return False
        # Recheck freshness after reading, and compute liveness from capture
        # time rather than the later time that the server discovered the file.
        age = time.time() - stat.st_mtime
        if not 0 <= age < self.stale_after:
            return False
        with self._lock:
            captured_seen = time.monotonic() - age
            if self._last_seen is None or captured_seen > self._last_seen:
                self._last_seen = captured_seen
            captured_at = stat.st_mtime_ns // 1_000_000
            self._received_at = max(self._received_at, captured_at)
            newer_capture = stat.st_mtime_ns >= self._snapshot_ns
            changed = False
            for index, value in enumerate(values):
                if newer_capture:
                    self._modulated[index] = modulated[index]
                    changed = True
                if self._base_updated_ns[index] <= stat.st_mtime_ns:
                    self._base_values[index] = math.floor(value / 255 * 127 + 0.5)
                    self._base_updated_at[index] = captured_at
                    self._base_updated_ns[index] = stat.st_mtime_ns
                    changed = True
                # GetChVal() is unmodulated; it cannot stand in for a live output
                # while an effect runs. Even for static channels, keep any OSC
                # output already received rather than resetting it to the base.
                if self._values[index] is None and self._modulated[index] is False:
                    self._values[index] = self._base_values[index]
                    self._updated_at[index] = self._base_updated_at[index]
                    self._updated_ns[index] = self._base_updated_ns[index]
                    changed = True
            if newer_capture:
                self._snapshot_ns = stat.st_mtime_ns
                self._snapshot_at = captured_at
            if changed:
                self._revision += 1
        return True

    def snapshot(self):
        with self._lock:
            return {
                "instanceId": self._instance_id,
                "connected": self._last_seen is not None
                and time.monotonic() - self._last_seen < self.stale_after,
                "revision": self._revision,
                "receivedAt": self._received_at,
                "values": self._values.copy(),
                "updatedAt": self._updated_at.copy(),
                "baseValues": self._base_values.copy(),
                "baseUpdatedAt": self._base_updated_at.copy(),
                "modulated": self._modulated.copy(),
                "snapshotAt": self._snapshot_at,
                "knownChannels": sum(value is not None for value in self._values),
            }


class RemoteHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, status, **kwargs):
        self.status = status
        super().__init__(*args, **kwargs)

    def _status_response(self, include_body):
        body = json.dumps(self.status.snapshot(), separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if include_body:
            self.wfile.write(body)

    def do_GET(self):
        if urlsplit(self.path).path == "/api/dmxis/status":
            self._status_response(True)
        else:
            super().do_GET()

    def do_HEAD(self):
        if urlsplit(self.path).path == "/api/dmxis/status":
            self._status_response(False)
        else:
            super().do_HEAD()

    def log_message(self, format, *args):
        # Polling the status endpoint several times a second should stay quiet.
        if urlsplit(self.path).path != "/api/dmxis/status":
            super().log_message(format, *args)


def listen_for_feedback(udp_socket, status, stop, snapshot_file=None):
    next_snapshot_check = 0
    while not stop.is_set():
        if snapshot_file is not None and time.monotonic() >= next_snapshot_check:
            status.load_snapshot(snapshot_file)
            next_snapshot_check = time.monotonic() + 0.5
        try:
            packet, _ = udp_socket.recvfrom(65535)
        except socket.timeout:
            continue
        except OSError:
            if not stop.is_set():
                raise
            break
        status.receive(packet)


def port_number(value):
    try:
        port = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("Port must be an integer") from exc
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("Port must be between 1 and 65535")
    return port


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=port_number, default=8765, help="Local HTTP port (default: 8765)")
    parser.add_argument("--osc-port", type=port_number, default=9000, help="DMXIS feedback UDP port (default: 9000)")
    parser.add_argument("--snapshot-file", default="/tmp/dmxis-remote-snapshot.json",
                        help="Atomic DMXIS macro snapshot file (default: /tmp/dmxis-remote-snapshot.json)")
    args = parser.parse_args()
    status = DMXISStatus()
    stop = threading.Event()
    handler = functools.partial(RemoteHandler, status=status, directory=str(Path(__file__).resolve().parent))
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp_socket:
        try:
            udp_socket.bind((LOOPBACK, args.osc_port))
            udp_socket.settimeout(0.5)
            http_server = ThreadingHTTPServer((LOOPBACK, args.port), handler)
        except OSError as exc:
            parser.exit(1, f"Cannot start the local DMXIS server: {exc}\n")
        listener = threading.Thread(target=listen_for_feedback,
                                    args=(udp_socket, status, stop, args.snapshot_file), daemon=True)
        listener.start()
        print(f"Remote: http://{LOOPBACK}:{args.port}/dmxis/", flush=True)
        print(f"Listening for DMXIS OSC feedback on {LOOPBACK}:{args.osc_port}", flush=True)
        try:
            http_server.serve_forever(poll_interval=0.25)
        except KeyboardInterrupt:
            pass
        finally:
            stop.set()
            http_server.server_close()
            listener.join(timeout=1)


if __name__ == "__main__":
    main()
