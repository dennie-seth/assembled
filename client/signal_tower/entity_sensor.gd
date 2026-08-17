## Entity sensor logic per docs/design/11-moment-to-moment.md §1.
##
## One entity = one sensor category. Combining sensors on one entity is
## deliberately deferred past the vertical slice (11 §1).
##
## Sensor parameters are the first-pass values from 14 §10; tuning happens
## on playtest per 11 M-2. Any retuning must be recorded in the decision log.

class_name EntitySensor

const RoomTypes: GDScript = preload("res://signal_tower/room_types.gd")

## First-pass parameter table (14 §10) ─────────────────────────────────────

## Watcher — sight cone
const WATCHER_CONE_ANGLE_DEG: float = 90.0
const WATCHER_CONE_RANGE_TILES: float = 6.0
const WATCHER_SWEEP_PASS_SEC: float = 4.0
const WATCHER_SWEEP_PAUSE_SEC: float = 2.0

## Sound — sound radius
const SOUND_RADIUS_WALK_TILES: float = 1.5   ## midpoint of 1–2 tile range
const SOUND_RADIUS_RUN_TILES: float = 5.0

## Still Air — proximity/patrol
const STILL_AIR_LAP_SEC: float = 25.0        ## midpoint of 20–30s range
const STILL_AIR_CATCH_RADIUS_TILES: float = 1.5

## Instance state ─────────────────────────────────────────────────────────────

var _category: int = -1   ## RoomTypes.SensorCategory value
var _entity_name: String = ""

## Accessors for first-pass parameter table (exposed so tests can verify values)

func get_watcher_cone_angle_deg() -> float:
	return WATCHER_CONE_ANGLE_DEG

func get_watcher_cone_range_tiles() -> float:
	return WATCHER_CONE_RANGE_TILES

func get_watcher_sweep_pass_sec() -> float:
	return WATCHER_SWEEP_PASS_SEC

func get_watcher_sweep_pause_sec() -> float:
	return WATCHER_SWEEP_PAUSE_SEC

func get_sound_radius_walk_tiles() -> float:
	return SOUND_RADIUS_WALK_TILES

func get_sound_radius_run_tiles() -> float:
	return SOUND_RADIUS_RUN_TILES

func get_still_air_lap_sec() -> float:
	return STILL_AIR_LAP_SEC

func get_still_air_catch_radius_tiles() -> float:
	return STILL_AIR_CATCH_RADIUS_TILES

## Sensor initialisation ──────────────────────────────────────────────────────

## Initialise as a sight-cone sensor (The Watcher).
func init_sight_cone(p_name: String) -> void:
	_category = RoomTypes.SensorCategory.SIGHT_CONE
	_entity_name = p_name

## Initialise as a sound-radius sensor (The Sound).
func init_sound_radius(p_name: String) -> void:
	_category = RoomTypes.SensorCategory.SOUND_RADIUS
	_entity_name = p_name

## Initialise as a proximity/patrol sensor (The Still Air).
func init_proximity_patrol(p_name: String) -> void:
	_category = RoomTypes.SensorCategory.PROXIMITY_PATROL
	_entity_name = p_name

## Return the sensor category as a string key (used by tests).
func get_sensor_type() -> String:
	match _category:
		RoomTypes.SensorCategory.SIGHT_CONE:
			return "SIGHT_CONE"
		RoomTypes.SensorCategory.SOUND_RADIUS:
			return "SOUND_RADIUS"
		RoomTypes.SensorCategory.PROXIMITY_PATROL:
			return "PROXIMITY_PATROL"
	return "UNKNOWN"

func get_entity_name() -> String:
	return _entity_name

## Detection query ─────────────────────────────────────────────────────────────

## Returns true if a player at player_tile (tile coordinates) is detected.
##
## player_tile:       player position in tile coords
## entity_tile:       entity position in tile coords
## entity_facing_deg: direction entity faces (0 = east / +X, measured from +X CCW)
## movement_state:    "walk" or "run" — consumed only by SOUND_RADIUS
## patrol_phase:      0.0–1.0, normalised position in patrol lap — unused currently
##
## Geometry blocking (cover for SIGHT_CONE) is the renderer's responsibility,
## not the sensor's. The sensor evaluates only angle/range.
func is_detected(
	player_tile: Vector2,
	entity_tile: Vector2,
	entity_facing_deg: float,
	movement_state: String,
	patrol_phase: float
) -> bool:
	var dist: float = player_tile.distance_to(entity_tile)
	match _category:
		RoomTypes.SensorCategory.SIGHT_CONE:
			return _sight_cone_detected(player_tile, entity_tile, entity_facing_deg, dist)
		RoomTypes.SensorCategory.SOUND_RADIUS:
			return _sound_radius_detected(dist, movement_state)
		RoomTypes.SensorCategory.PROXIMITY_PATROL:
			return dist <= STILL_AIR_CATCH_RADIUS_TILES
	return false

func _sight_cone_detected(
	player_tile: Vector2,
	entity_tile: Vector2,
	entity_facing_deg: float,
	dist: float
) -> bool:
	if dist > WATCHER_CONE_RANGE_TILES:
		return false
	if dist <= 0.0:
		return true  ## entity and player occupy the same tile
	var to_player: Vector2 = (player_tile - entity_tile).normalized()
	var facing: Vector2 = Vector2.from_angle(deg_to_rad(entity_facing_deg))
	var half_cone: float = WATCHER_CONE_ANGLE_DEG * 0.5
	## angle_to returns signed angle from facing to to_player; abs for half-cone check
	var angle_deg: float = rad_to_deg(absf(facing.angle_to(to_player)))
	return angle_deg <= half_cone

func _sound_radius_detected(dist: float, movement_state: String) -> bool:
	var radius: float = SOUND_RADIUS_RUN_TILES if movement_state == "run" else SOUND_RADIUS_WALK_TILES
	return dist <= radius
