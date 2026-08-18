class_name SightConeSensorV2
extends Node
## Composable sight-cone sensor for the side-on floor plane (T-0189 / §11 §4 v5).
##
## Replaces SightConeSensor (T-0174) for the rebuilt side-on model.  All
## positions are floor-plane X coordinates (floats); the Y axis is shared and
## constant (floor_y) across all entities, so range and facing are purely 1-D.
##
## Add as a child of any entity node.  Each frame set entity_plane_x and
## entity_facing_dir, then call check(player_plane_x) to query detection.
##
## Cover is horizontal occlusion on the floor plane: a foreground prop whose
## X interval strictly overlaps the segment between entity and player blocks
## the sight cone.  Cover does NOT block sound or proximity (see V2 siblings).
##
## Room geometry occlusion (occluder_fn) is preserved from T-0174 — it is
## supplementary to cover, not replaced by it.  Inject the tilemap/physics
## raycast here; leave invalid for tests with no physics space.
##
## last_check_was_occluded is true when the most recent check() was blocked by
## room geometry or a cover prop (never by range or facing misses).

## Emitted on the transition: not-detected → detected.
## @param target_plane_x  The player's X position on the floor plane.
signal target_detected(target_plane_x: float)

## Emitted on the transition: detected → not-detected.
signal target_cleared()

## Entity's X position on the side-on floor plane in pixels.
## Updated by the owning entity each frame before calling check().
var entity_plane_x: float = 0.0

## Facing direction: +1.0 = facing right, -1.0 = facing left.
## Updated by the owning entity to match its sprite/animation direction.
var entity_facing_dir: float = 1.0

## Detection range in tiles.
@export var range_tiles: float = 6.0

## Pixels per tile — must match the project tilemap.
@export var tile_size: float = 16.0

## Foreground prop cover intervals.  Each Vector2 encodes (min_x, max_x) in
## pixels on the floor plane.  A prop whose interval strictly overlaps the
## segment [entity_plane_x, player_plane_x] blocks the sight cone.
## Populated by the room runtime; cleared when props are removed.
## A prop whose interval only touches an endpoint (zero-width at entity or
## player position) does NOT block, by the strict-overlap rule.
var cover_props: Array[Vector2] = []

## Room geometry occluder: (from_plane_x: float, to_plane_x: float) → bool.
## Return true if room geometry blocks the line from entity to player.
## Preserved from T-0174 for wall/tilemap blocking.  Leave as invalid
## Callable for headless tests and when no geometry check is needed.
var occluder_fn: Callable

## True iff the most recent check() was blocked by room geometry or a cover
## prop.  False on range misses, facing misses, or successful detections.
var last_check_was_occluded: bool = false

var _was_detected: bool = false


## Returns true iff player_plane_x is in the entity's facing direction, within
## range, and unoccluded by geometry or cover props.  Emits target_detected /
## target_cleared on state transitions.
##
## @param player_plane_x  Player's X position on the floor plane in pixels.
func check(player_plane_x: float) -> bool:
	last_check_was_occluded = false

	var dx: float = player_plane_x - entity_plane_x

	# Range check: horizontal distance only on the floor plane.
	if absf(dx) > range_tiles * tile_size:
		_transition_cleared()
		return false

	# Facing check: player must be strictly in the entity's facing direction.
	# dx * entity_facing_dir > 0  →  player is in front.
	# dx * entity_facing_dir <= 0 →  player is at same position or behind.
	if dx * entity_facing_dir <= 0.0:
		_transition_cleared()
		return false

	# Room geometry occlusion (from T-0174, unchanged).
	if occluder_fn.is_valid() and occluder_fn.call(entity_plane_x, player_plane_x):
		last_check_was_occluded = true
		_transition_cleared()
		return false

	# Horizontal occlusion by foreground props (cover, §11 §4 v5 redefinition).
	if _is_cover_occluded(entity_plane_x, player_plane_x):
		last_check_was_occluded = true
		_transition_cleared()
		return false

	_transition_detected(player_plane_x)
	return true


## Returns true if any cover prop strictly overlaps the segment (from_x, to_x).
## "Strictly" means the prop's interval must satisfy:
##   prop.y > seg_min  AND  prop.x < seg_max
## A zero-width prop at an endpoint satisfies neither condition, so endpoints
## (entity position, player position) are excluded — no false-negative, no crash.
func _is_cover_occluded(from_x: float, to_x: float) -> bool:
	if cover_props.is_empty():
		return false
	var seg_min: float = minf(from_x, to_x)
	var seg_max: float = maxf(from_x, to_x)
	for prop: Vector2 in cover_props:
		# prop.x = interval min, prop.y = interval max.
		if prop.y > seg_min and prop.x < seg_max:
			return true
	return false


func _transition_detected(plane_x: float) -> void:
	if not _was_detected:
		_was_detected = true
		target_detected.emit(plane_x)


func _transition_cleared() -> void:
	if _was_detected:
		_was_detected = false
		target_cleared.emit()
