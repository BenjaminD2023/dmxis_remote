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

Changing MIDI output sends all 512 current remote values. Changing pages or rebuilding the faders sends the visible values, except during color changes and their undo/redo. The remote starts with zero values and does not read the current DMXIS levels.

Select a fixture and press `C` to choose a color. Gobos use their `Colors` macro channel and switch directly to the saved preset value, including on undo/redo. Supported gobo colors are Warm White, White, Cool White, Red, Orange, Yellow, Green, Blue, Indigo, and Hot Pink; other shades show “Unavailable for gobos.” These values match the local DMXIS `Gobos - ALL` presets. RGB fixtures keep their color fade. When gobos and RGB fixtures are selected together, only colors supported by both are available.

Future contributions to the original website belong in a separate fork.
