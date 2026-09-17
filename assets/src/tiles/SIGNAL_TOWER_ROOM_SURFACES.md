# Signal Tower room -> surface mapping (T-0232)

HANDOFF §23-i: this card's tileset (base fields + transitions) must cover
enough distinct surfaces to dress all seven Signal Tower rooms
(`docs/design/14-vertical-slice.md` §10). This table is the mapping
required by that card's acceptance criteria.

| Room (anchor tag) | Wall surface | Floor surface | Why |
|---|---|---|---|
| Ground Relay (`ground_relay`) | `wall` | `floor` | `14` §10: "Wide, single-height, open floor" — the tower's ordinary painted interior. |
| Records Room (`records_room`) | `wall` | `floor` | `14` §10: "Smaller, dense shelving rows (records-office dressing)" — same painted interior; shelving is a prop, not a tile surface. |
| Power Substation (`power_substation`) | `wall` | `floor` | `14` §10: "Rectangular, breaker panel along the back wall" — same painted interior; panel/housings are props. |
| Equipment Floor (`equipment_floor`) | `wall` | `floor` | `14` §10: "Cluttered, maze-like rack layout" — same painted interior; racks are props. |
| Storage Cache (`storage_cache`) | `concrete` | `floor` | `14` §10: "Small, cramped closet" — an unfinished utility space, not the tower's dressed interior. |
| Antenna Shaft (`antenna_shaft`) | `concrete` | `floor` | `14` §10: "Narrow vertical shaft, winding ladder path" — raw mechanical/structural shaft, closest to T-0226's structural concept sheet (catwalk/grating/ladder panels), not painted wall. |
| Broadcast Deck (`broadcast_deck`) | `wall` | `floor` | `14` §10: "Open deck, tear as a chroma-lit centerpiece" — same painted interior; the tear itself is a shader effect (`13-asset-pipeline.md` §4), not a tile surface. |

**Two material pairs, not seven per-room surfaces.** Five of the seven
rooms share the ordinary painted-concrete interior (`wall`/`floor`); the
two utility/mechanical rooms (Storage Cache, Antenna Shaft) share the raw
`concrete`/`floor` pair. This matches `docs/design/13-asset-pipeline.md`
§3.4's own scope ("base fields: wall, floor, concrete") rather than
inventing a distinct surface per room, and keeps the declared-adjacency
set small enough to fully gate-test (20 pairs, `tests/test_signal_tower_transitions_gate.py`)
while still giving every room a floor to stand on and a wall to be
bounded by.

## Delivered tiles

| File | Kind | Path strategy |
|---|---|---|
| `wall_16px.png` | Base field | Circular-pad (`13` §3.4) — real SDXL txt2img (`sd_xl_base_1.0.safetensors`, 1024x1024) → descend (T-0073) → deterministic outer-ring seam-forcing |
| `floor_16px.png` | Base field | Circular-pad (`13` §3.4) — same chain as `wall_16px.png` |
| `concrete_16px.png` | Base field | Circular-pad (`13` §3.4) — same chain as `wall_16px.png` |
| `transitions_16px.png` | Transitions (corners, edges, wall->floor and concrete->floor) | Sliced sheet (`13` §3.4) — deterministic construction (T-0153 precedent); plain wall/floor/concrete cells are pixel-identical copies of the real base fields above |

All four committed under `assets/final/tiles/signal_tower/`, each with a
P-7-compliant `.provenance.json` sidecar. See
`assets/src/tiles/src/tile_gen/base_fields.py` (real circular-pad
generation: SDXL → `comfy_client.descend` → deterministic outer-ring
seam-forcing, module docstring explains why the ring is forced),
`assets/src/tiles/src/tile_gen/fields.py` (the sliced-sheet transition/
corner constructors), and
`assets/src/tiles/src/tile_gen/signal_tower_sheet.py` (composes the
sheet, embedding the real base fields byte-for-byte into their cells) for
the generators, and
`assets/src/tiles/tests/test_signal_tower_base_fields_gate.py` /
`assets/src/tiles/tests/test_signal_tower_transitions_gate.py` for the
T-0102 gate proof (seamlessness on all 3 base fields; adjacency on all 20
declared pairs; sheet-cell identity on all 3 shared base fields).
