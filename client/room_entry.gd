## RoomEntry — anchor-based room entry flow (T-0176).
##
## Coordinates the room-entry sequence for a single anchor:
##   1. Calls GET /v1/anchors/{archetype}/{tag} via NoteClient (T-0124).
##   2. Parses the JSON response; renders note text via NoteRenderer.
##   3. Emits anchor_ready with all three visibility classes (items,
##      offerings, rendered_notes) at the registered AnchorRegistry position.
##   4. On fetch failure or timeout, emits anchor_failed instead so the room
##      still loads without anchor dressing — offline-runnable per 01 §5
##      and T-0067.
##
## Usage:
##   var entry := RoomEntry.new()
##   entry.setup(note_client, anchor_registry, note_renderer)
##   entry.anchor_ready.connect(_on_anchor_ready)
##   entry.anchor_failed.connect(_on_anchor_failed)
##   entry.enter_room(archetype_id, tag)
extends RefCounted

## Emitted when the anchor snapshot has been fetched and all three visibility
## classes rendered.
## @param position        Registered spawn-point from AnchorRegistry.
## @param items           Array of item-instance Dictionaries from the server.
## @param offerings       Array of offering Dictionaries from the server.
## @param rendered_notes  Array of Dictionaries {"id": String, "text": String}.
signal anchor_ready(position: Vector2, items: Array, offerings: Array, rendered_notes: Array)

## Emitted when the fetch fails or times out (offline / degraded mode).
## The room should load without anchor dressing at this anchor.
## @param archetype_id  Archetype ID passed to enter_room.
## @param tag           Anchor tag passed to enter_room.
signal anchor_failed(archetype_id: int, tag: int)

var _note_client: NoteClient
var _anchor_registry: AnchorRegistry
var _note_renderer: NoteRenderer
var _pending_archetype_id: int = -1
var _pending_tag: int = -1
var _pending_req_id: int = -1


## Wire up the three required dependencies and connect to NoteClient's signal.
## Must be called once before enter_room.
## @param client    Configured NoteClient node.
## @param registry  AnchorRegistry with this room's anchor positions registered.
## @param renderer  NoteRenderer for converting template+slots to display text.
func setup(client: NoteClient, registry: AnchorRegistry, renderer: NoteRenderer) -> void:
	_note_client = client
	_anchor_registry = registry
	_note_renderer = renderer
	_note_client.anchor_snapshot_fetched.connect(_on_snapshot_fetched)


## Begin the room-entry sequence for the given anchor.
## Returns the NoteClient request ID, or -1 if the fetch could not be queued.
## @param archetype_id  Archetype ID (from shared/note_templates.hpp).
## @param tag           Anchor tag scoped to that archetype.
func enter_room(archetype_id: int, tag: int) -> int:
	_pending_archetype_id = archetype_id
	_pending_tag = tag
	var req_id: int = _note_client.fetch_anchor_snapshot(archetype_id, tag)
	_pending_req_id = req_id
	return req_id


## Internal: called by NoteClient when the anchor snapshot fetch completes.
func _on_snapshot_fetched(
		req_id: int, state: int, _http_status: int, body: String) -> void:
	if req_id != _pending_req_id:
		return

	if state != NoteClient.STATE_OK:
		anchor_failed.emit(_pending_archetype_id, _pending_tag)
		return

	var position: Vector2 = _anchor_registry.resolve(_pending_archetype_id, _pending_tag)

	var json := JSON.new()
	if json.parse(body) != OK:
		push_error(
			"RoomEntry: JSON parse failed for anchor archetype=%d tag=%d"
			% [_pending_archetype_id, _pending_tag]
		)
		anchor_failed.emit(_pending_archetype_id, _pending_tag)
		return

	var data: Dictionary = json.get_data()
	var items: Array = data.get("items", [])
	var offerings: Array = data.get("offerings", [])
	var raw_notes: Array = data.get("notes", [])

	var rendered_notes: Array = []
	for note: Dictionary in raw_notes:
		var text: String = _note_renderer.render(
			int(note.get("template_id", 0)),
			int(note.get("slot_a", 0)),
			int(note.get("slot_b", 0)),
			str(note.get("item_ref", ""))
		)
		rendered_notes.append({"id": str(note.get("id", "")), "text": text})

	anchor_ready.emit(position, items, offerings, rendered_notes)
