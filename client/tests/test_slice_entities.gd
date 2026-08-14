extends SceneTree
## T-0178: Three vertical-slice hazard entities — Watcher, Sound, Still Air.
##
## Verifies that each entity:
##   - Carries exactly one sensor from the sensor kit (T-0174)
##     (docs/design/11-moment-to-moment.md §1)
##   - Delegates detection entirely to that sensor, with no entity-specific
##     detection logic of its own
##   - Uses HAZARD vocabulary names from the notes system
##     (docs/design/02-notes-system.md §2)
##
## Also verifies the edge case: no i-frame on hiding-spot transition —
## an entity with the player in detection range catches them even while
## the player is mid-transition into a hiding spot (player_in_cover=false).
##
## Sensors use T-0174 defaults: SightCone range=6t×16px=96px,
## SoundRadius run_radius=5t×16px=80px walk_radius=1.5t×16px=24px,
## ProximityPatrol catch_radius=1.5t×16px=24px.
##
## Run headless:
##   godot --headless --script tests/test_slice_entities.gd
## from client/. Exit 0 on PASS, 1 on any failure.

func _init() -> void:
	var failures: Array[String] = []

	# ── Load sensor and entity scripts ───────────────────────────────────────
	# Using load() so missing files produce null (clean FAIL) rather than a
	# parse-time crash, preserving the red state before implementation.
	var SightConeSensor = load("res://sensors/sight_cone_sensor.gd")
	var SoundRadiusSensor = load("res://sensors/sound_radius_sensor.gd")
	var ProximityPatrolSensor = load("res://sensors/proximity_patrol_sensor.gd")
	var WatcherEntity = load("res://entities/watcher_entity.gd")
	var SoundEntity = load("res://entities/sound_entity.gd")
	var StillAirEntity = load("res://entities/still_air_entity.gd")

	if SightConeSensor == null:
		failures.append("sensors/sight_cone_sensor.gd not found — sensor kit not implemented")
	if SoundRadiusSensor == null:
		failures.append("sensors/sound_radius_sensor.gd not found — sensor kit not implemented")
	if ProximityPatrolSensor == null:
		failures.append("sensors/proximity_patrol_sensor.gd not found — sensor kit not implemented")
	if WatcherEntity == null:
		failures.append("entities/watcher_entity.gd not found")
	if SoundEntity == null:
		failures.append("entities/sound_entity.gd not found")
	if StillAirEntity == null:
		failures.append("entities/still_air_entity.gd not found")

	if not failures.is_empty():
		for f: String in failures:
			printerr("T-0178 FAIL: %s" % f)
		quit(1)
		return

	# ── Per-entity behavioral tests ──────────────────────────────────────────
	_test_watcher(WatcherEntity, SightConeSensor, failures)
	_test_sound(SoundEntity, SoundRadiusSensor, failures)
	_test_still_air(StillAirEntity, ProximityPatrolSensor, failures)

	# ── Edge case: no i-frame on hiding-spot transition ──────────────────────
	_test_mid_transition_catch(WatcherEntity, StillAirEntity, failures)

	# ── Report ───────────────────────────────────────────────────────────────
	if failures.is_empty():
		print("T-0178 PASS: Watcher/Sound/StillAir each carry one sensor; detection delegates correctly; no i-frame on hide transition")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0178 FAIL: %s" % f)
		quit(1)


func _test_watcher(WatcherEntity: Resource, SightConeSensor: Resource, failures: Array[String]) -> void:
	var watcher = WatcherEntity.new()

	# HAZARD vocabulary (02-notes-system.md §2): "the watcher"
	if not watcher.get("HAZARD_LABEL") == &"the watcher":
		failures.append("WatcherEntity.HAZARD_LABEL: expected 'the watcher', got '%s'" % str(watcher.get("HAZARD_LABEL")))

	# Carries exactly one sensor; sensor must be a SightConeSensor (T-0174)
	var sensor = watcher.get("sensor")
	if sensor == null:
		failures.append("WatcherEntity.sensor is null — must carry a SightConeSensor")
		return
	if not (sensor is SightConeSensor):
		failures.append("WatcherEntity.sensor must be a SightConeSensor instance")

	# Detection parameters — use T-0174 defaults: range=6t×16=96px, cone_half=45°
	var entity_pos: Vector2 = Vector2.ZERO
	var entity_facing: Vector2 = Vector2.RIGHT  # angle() == 0.0 → facing +X

	# Player directly ahead at 50px (within 96px range), not in cover → detect
	var player_ahead: Vector2 = Vector2(50.0, 0.0)
	var detect_ahead: bool = watcher.is_detecting(entity_pos, entity_facing, player_ahead, false)
	# After is_detecting() the sensor state is set; re-check must agree.
	var sensor_ahead: bool = sensor.check(player_ahead)
	if detect_ahead != sensor_ahead:
		failures.append("WatcherEntity.is_detecting() diverges from sensor.check() [ahead case] — entity has detection logic of its own")
	if not detect_ahead:
		failures.append("WatcherEntity: player directly ahead (50px), not in cover, in range — should be detected")

	# Player far ahead at 200px (beyond 96px range) → no detect
	var player_far: Vector2 = Vector2(200.0, 0.0)
	var detect_far: bool = watcher.is_detecting(entity_pos, entity_facing, player_far, false)
	if detect_far:
		failures.append("WatcherEntity: player out of sight range (200px > 96px) should not be detected")

	# Player directly behind → outside cone → no detect
	var player_behind: Vector2 = Vector2(-50.0, 0.0)
	var detect_behind: bool = watcher.is_detecting(entity_pos, entity_facing, player_behind, false)
	if detect_behind:
		failures.append("WatcherEntity: player behind entity is outside sight cone — should not be detected")

	# Player ahead but in cover → occluder blocks sight cone → no detect
	var detect_cover: bool = watcher.is_detecting(entity_pos, entity_facing, player_ahead, true)
	if detect_cover:
		failures.append("WatcherEntity: player in cover should not be detected by sight cone")

	sensor.free()


func _test_sound(SoundEntity: Resource, SoundRadiusSensor: Resource, failures: Array[String]) -> void:
	var sound_ent = SoundEntity.new()

	# HAZARD vocabulary (02-notes-system.md §2): "the sound"
	if not sound_ent.get("HAZARD_LABEL") == &"the sound":
		failures.append("SoundEntity.HAZARD_LABEL: expected 'the sound', got '%s'" % str(sound_ent.get("HAZARD_LABEL")))

	# Carries exactly one sensor; sensor must be a SoundRadiusSensor (T-0174)
	var sensor = sound_ent.get("sensor")
	if sensor == null:
		failures.append("SoundEntity.sensor is null — must carry a SoundRadiusSensor")
		return
	if not (sensor is SoundRadiusSensor):
		failures.append("SoundEntity.sensor must be a SoundRadiusSensor instance")

	# T-0174 defaults: run_radius=5t×16=80px, walk_radius=1.5t×16=24px
	var entity_pos: Vector2 = Vector2.ZERO
	var player_close: Vector2 = Vector2(50.0, 0.0)   # inside 80px run_radius
	var player_far: Vector2 = Vector2(200.0, 0.0)    # outside run_radius

	# Running player nearby (50px < 80px run_radius) → detect (punishes running blind)
	var detect_run_close: bool = sound_ent.is_detecting(entity_pos, player_close, true)
	# After is_detecting() the sensor state is set; re-check must agree.
	var sensor_run_close: bool = sensor.check(player_close)
	if detect_run_close != sensor_run_close:
		failures.append("SoundEntity.is_detecting() diverges from sensor.check() [run-close case] — entity has detection logic of its own")
	if not detect_run_close:
		failures.append("SoundEntity: running player nearby (50px) should be detected")

	# Running player out of run_radius (200px > 80px) → no detect
	var detect_run_far: bool = sound_ent.is_detecting(entity_pos, player_far, true)
	if detect_run_far:
		failures.append("SoundEntity: running player out of run_radius (200px > 80px) should not be detected")

	# Walking player far away (200px > 24px walk_radius) → no detect
	var detect_walk_far: bool = sound_ent.is_detecting(entity_pos, player_far, false)
	if detect_walk_far:
		failures.append("SoundEntity: walking player far away (200px) should not be detected (beyond walk_radius)")

	sensor.free()


func _test_still_air(StillAirEntity: Resource, ProximityPatrolSensor: Resource, failures: Array[String]) -> void:
	var still_air = StillAirEntity.new()

	# HAZARD vocabulary (02-notes-system.md §2): "the still air"
	if not still_air.get("HAZARD_LABEL") == &"the still air":
		failures.append("StillAirEntity.HAZARD_LABEL: expected 'the still air', got '%s'" % str(still_air.get("HAZARD_LABEL")))

	# Carries exactly one sensor; sensor must be a ProximityPatrolSensor (T-0174)
	var sensor = still_air.get("sensor")
	if sensor == null:
		failures.append("StillAirEntity.sensor is null — must carry a ProximityPatrolSensor")
		return
	if not (sensor is ProximityPatrolSensor):
		failures.append("StillAirEntity.sensor must be a ProximityPatrolSensor instance")

	# T-0174 defaults: catch_radius=1.5t×16=24px
	var entity_pos: Vector2 = Vector2.ZERO
	var player_close: Vector2 = Vector2(20.0, 0.0)   # inside 24px catch_radius
	var player_far: Vector2 = Vector2(200.0, 0.0)    # outside catch_radius

	# Player within patrol catch_radius (20px < 24px) → detect (no LOS check — inevitable)
	var detect_close: bool = still_air.is_detecting(entity_pos, player_close)
	# After is_detecting() the sensor state is set; re-check must agree.
	var sensor_close: bool = sensor.check(player_close)
	if detect_close != sensor_close:
		failures.append("StillAirEntity.is_detecting() diverges from sensor.check() [close case] — entity has detection logic of its own")
	if not detect_close:
		failures.append("StillAirEntity: player within patrol catch_radius (20px < 24px) should be detected")

	# Player outside patrol catch_radius (200px > 24px) → no detect
	var detect_far: bool = still_air.is_detecting(entity_pos, player_far)
	if detect_far:
		failures.append("StillAirEntity: player outside catch_radius (200px > 24px) should not be detected")

	sensor.free()


func _test_mid_transition_catch(WatcherEntity: Resource, StillAirEntity: Resource, failures: Array[String]) -> void:
	## Edge case: no i-frame on hiding-spot transition (11-moment-to-moment.md §2).
	## A player mid-transition is NOT yet safely inside the hiding spot:
	## player_in_cover=false for SightCone; proximity check still active for StillAir.
	## Entities must still catch them — no immunity window during the transition.
	var entity_pos: Vector2 = Vector2.ZERO

	# Watcher: player at 50px ahead, player_in_cover=false (mid-transition, not yet safe)
	var player_watcher: Vector2 = Vector2(50.0, 0.0)  # within 96px sight range
	var watcher = WatcherEntity.new()
	var watcher_catches: bool = watcher.is_detecting(entity_pos, Vector2.RIGHT, player_watcher, false)
	if not watcher_catches:
		failures.append("Edge case (no i-frame): Watcher must catch player mid-transition into hiding spot")
	watcher.sensor.free()

	# Still Air: player at 20px (within 24px catch_radius), no cover concept applies
	var player_still_air: Vector2 = Vector2(20.0, 0.0)  # within 24px catch_radius
	var still_air = StillAirEntity.new()
	var still_air_catches: bool = still_air.is_detecting(entity_pos, player_still_air)
	if not still_air_catches:
		failures.append("Edge case (no i-frame): Still Air must catch player mid-transition into hiding spot")
	still_air.sensor.free()
