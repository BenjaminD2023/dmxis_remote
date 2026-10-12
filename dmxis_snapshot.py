"""Read the current 512 DMXIS faders for the local Mac remote.

Run inside DMXIS: install in its Macros/Remote Sync folder, then select the
macro from the Macros menu while the remote's local bridge is running.
This seeds an initial snapshot; enable DMXIS OSC for subsequent live changes.
Uses getters only and works with the embedded Python 2.6 interpreter.
"""

import os
from _DmxApi import GetChVal, GetOscType, GetOscAmount, GetStLevel


def export_remote_snapshot():
    values = [int(GetChVal(channel)) for channel in range(512)]
    if any(value < 0 or value > 255 for value in values):
        raise ValueError("DMXIS returned a channel value outside 0-255")
    # OSC shows the current output of these effects, not the underlying base
    # fader. Mark these channels so restoring a flash never writes an animated
    # output sample back into the base setting.
    modulated = [((GetOscType(channel) != 0 and
                   GetOscAmount(channel) > 0) or GetStLevel(channel) > 0)
                 for channel in range(512)]

    # DMXIS's embedded Python omits some native standard-library modules.
    # Built-in file I/O and os.rename avoid socket, struct, and JSON imports.
    # The bridge observes the file's modification time and reads it once.
    snapshot_path = "/tmp/dmxis-remote-snapshot.json"
    temporary_path = snapshot_path + ".tmp"
    output = open(temporary_path, "w")
    try:
        output.write('{"source":"dmxis-macro","values":[%s],'
                     '"modulated":[%s]}\n' %
                     (",".join(str(value) for value in values),
                      ",".join("true" if active else "false"
                               for active in modulated)))
    finally:
        output.close()
    os.rename(temporary_path, snapshot_path)

    print("Read 512 current DMXIS faders for the local remote.")


export_remote_snapshot()
