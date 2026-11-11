# matterbridge-printprogress

Matterbridge plugin that shows 3D printer print progress in Apple Home (or any Matter controller).

Each printer becomes two Matter devices:

- **Print Progress**: a dimmable light. Brightness is the print percentage. It is read-only; commands are undone on the next refresh.
- **Print Status**: a contact sensor. **Open** while a print is running or paused, **Closed** when idle, finished, cancelled or in error.

Supported printers: Klipper/Moonraker (`type: moonraker`, HTTP URL) and Creality WebSocket printers such as the K1C (`type: creality`, `ws://host:9999`). Requires Matterbridge >= 3.10 and Node >= 22.

Matterbridge talks Matter directly, so brightness updates reach Apple Home live. The SONOFF iHost Matter Bridge does not forward third-party brightness changes.

Ported from [printpercent](https://github.com/MCKanpolat/printpercent).
