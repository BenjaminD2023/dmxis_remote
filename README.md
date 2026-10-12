# DMXIS Remote

Standalone browser remote extracted from [biphtechtheater.github.io](https://github.com/biphtechtheater/biphtechtheater.github.io). This repository contains only the remote and its icon.

## Run locally

From the repository directory:

```sh
python3 -m http.server 8765 --bind 127.0.0.1
```

Open <http://127.0.0.1:8765/> in Chrome and allow MIDI access. The remote automatically selects `IAC Driver Bus 1` on macOS or a loopMIDI port on Windows when available.

On macOS, enable the IAC Driver in Audio MIDI Setup and enable `IAC Driver Bus 1` as an input in DMXIS. For physical DMX output, connect the DMXIS USB interface.

DMX channels 1–512 use MIDI CC 0–127 on MIDI channels 1–4, with values 0–127. The current DMXIS show must have matching MIDI Learn assignments; the remote does not configure them.

Changing MIDI output sends all 512 current remote values. Changing pages or rebuilding the faders sends the visible values. The remote starts with zero values and does not read the current DMXIS levels.

Future contributions to the original website belong in a separate fork.
