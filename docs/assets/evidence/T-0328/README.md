# T-0328 evidence — Signal Tower seven-room layout

`signal_tower_layout_map.png` is a schematic top-down map of the full
Signal Tower archetype, generated directly from the committed layout spec
(`client/signal_tower/layouts/signal_tower_v1.json`) by
`client/tools/render_signal_tower_evidence.gd`. Regenerate with:

```
cd client && godot --headless --script tools/render_signal_tower_evidence.gd
```

This is not a live screengrab. This sandbox's headless Godot instance
renders through the "Dummy" backend (no GPU available), which produces
blank frames — a `Viewport` screenshot here would be an empty image, not
evidence of anything. `Image` is pure CPU-side pixel manipulation with no
dependency on the rendering pipeline, so the generator instead draws a
pixel-accurate map of the authored geometry: every room's true tile
footprint and world position, plus each door/ladder opening at the exact
tile range `signal_tower_overview.gd`'s `_connection_geometry()` computes
for the live scene — the marker script mirrors that same math, so the
evidence cannot drift from what the game actually builds.

## What it shows

- One filled rectangle per room, true to its authored tile size and
  position (16 px/tile), colour-coded per room:
  - Ground Relay — blue-grey (entry)
  - Records Room — amber (Climax + Gate branch)
  - Power Substation — red (Gate + Hazard)
  - Equipment Floor — orange-brown (Hazard)
  - Storage Cache — grey (Transit branch)
  - Antenna Shaft — red-orange (Hazard) — visibly the tallest, narrowest
    room in the map, running the full height of the image
  - Broadcast Deck — purple (Tear)
- Orange bars mark the two door connections (Ground Relay → Records Room,
  Equipment Floor → Storage Cache — both branches, dead-ending back to
  their parent).
- Cyan bars mark the four ladder connections forming the main vertical
  path: Ground Relay → Power Substation → Equipment Floor → Antenna Shaft
  → Broadcast Deck.
- Reading top-to-bottom traces the critical path; the two branch rooms
  read as clear side-offshoots rather than part of the vertical descent —
  the layout this image shows is exactly what
  `test_T0328_room_layout.gd`'s connectivity check asserts against
  `SignalTowerChainSideon`'s canonical graph, and exactly what
  `signal_tower_overview.gd` builds into the walkable scene.
