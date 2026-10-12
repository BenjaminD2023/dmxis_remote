# DMXIS Remote

Standalone browser remote extracted from [biphtechtheater.github.io](https://github.com/biphtechtheater/biphtechtheater.github.io). This repository contains only the remote and its icon.

## Run locally

From the repository directory:

```sh
python3 dmxis_server.py
```

Open <http://127.0.0.1:8765/> in Chrome and allow MIDI access. The remote automatically selects `IAC Driver Bus 1` on macOS or a loopMIDI port on Windows when available.

On macOS, enable the IAC Driver in Audio MIDI Setup and enable `IAC Driver Bus 1` as an input in DMXIS. For physical DMX output, connect the DMXIS USB interface.

DMX channels 1–512 use MIDI CC 0–127 on MIDI channels 1–4, with values 0–127. The current DMXIS show must have matching MIDI Learn assignments; the remote does not configure them.

Opening the remote, changing pages or modes, and selecting a MIDI output preserve the current lights. Only control actions send MIDI; incoming sync updates never echo back to DMXIS.

## Automatic DMXIS sync on macOS

The local server receives DMXIS OSC feedback and updates the remote's faders and color previews automatically. It uses Python's standard library and listens only on this computer. Configure DMXIS **Settings → General → OSC Remote Control**:

- Enable OSC.
- Transmit to IP address: `127.0.0.1`.
- Transmit port: `9000` (matches the server's default `--osc-port`).

Copy `dmxis_snapshot.py` to `/Library/Application Support/ENTTEC/DMXIS/Macros/Remote Sync/Read current levels.py`. With the server running, choose **Macros → Remote Sync → Read current levels** inside DMXIS. This read-only macro captures all 512 base fader settings and effect flags; it changes no lights or presets. Run it again after restarting the server or changing native oscillator/sound-tracker settings. Current DMXIS changes then arrive automatically through OSC; the browser polls them every 250 ms. A fresh preset change can also populate live channel levels, but the macro supplies the underlying settings needed for flash restoration.

DMXIS OSC reports output levels including effects. The remote keeps those live readings separate from the base settings used to restore a flash. A channel without a known base is skipped by Space until it is captured or set from the remote. Native base-fader edits on a channel with active effects require another capture for accurate flash restoration, because OSC does not expose its underlying setting. The header shows sync connection and received-channel coverage; unreported channels show `?` rather than assuming zero. Connection loss is detected after three seconds. This reads software state, not confirmation of physical fixture output.

The OSC protocol is documented in the [DMXIS user manual](https://prostage.no/media/multicase/documents/pdf%20enttec/dmxis_manual_v1.70_um.pdf). A plain static HTTP server supports MIDI controls but cannot receive automatic DMXIS sync.

Select a fixture and press `C` to choose a color. Gobos use their `Colors` macro channel and switch directly to the saved preset value, including on undo/redo. Supported gobo colors are Warm White, White, Cool White, Red, Orange, Yellow, Green, Blue, Indigo, and Hot Pink; other shades show “Unavailable for gobos.” These values match the local DMXIS `Gobos - ALL` presets. RGB fixtures keep their color fade. When gobos and RGB fixtures are selected together, only colors supported by both are available.

Space runs a short flash and restores the previous underlying settings when it finishes. Holding Space or pressing it again during that flash does not start overlapping sequences. RGB colors and gobo macros retain their original values.

Future contributions to the original website belong in a separate fork.
