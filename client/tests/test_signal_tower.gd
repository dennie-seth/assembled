extends SceneTree
## T-0185: Signal Tower seven-room chain — room taxonomy, entity sensors,
## chain tear logic, and chroma shader validation.
##
## Covers:
##   - All 7 rooms defined with correct anchor tags and role assignments
##   - All 3 entities present with one sensor each (sight cone, sound radius,
##     proximity/patrol) — no sensor combining (11 §1)
##   - Sensor parameters match 14 §10 first-pass table
##   - Records Room tagged as Climax (11 §7) + Gate (puzzle-locked entry)
##   - Chain tear rejects crossing without Resonance Key
##   - Chain tear accepts crossing with key and stays open thereafter
##   - Re-crossing the open tear needs no further key
##   - Player can reach Broadcast Deck without visiting Records Room branch
##   - Chroma shader file exists with required uniform declarations
##
## Run headless:
##   godot --headless --script tests/test_signal_tower.gd
## from client/. Exit 0 on PASS, 1 on any failure.

func _init() -> void:
	var failures: Array[String] = []

	# ── Load classes ─────────────────────────────────────────────────────────
	var RoomTypesScript: GDScript = load("res://signal_tower/room_types.gd")
	var EntitySensorScript: GDScript = load("res://signal_tower/entity_sensor.gd")
	var ChainTearScript: GDScript = load("res://signal_tower/chain_tear.gd")
	var ChainScript: GDScript = load("res://signal_tower/signal_tower_chain.gd")

	if RoomTypesScript == null:
		printerr("T-0185 FAIL: could not load signal_tower/room_types.gd")
		quit(1)
		return
	if EntitySensorScript == null:
		printerr("T-0185 FAIL: could not load signal_tower/entity_sensor.gd")
		quit(1)
		return
	if ChainTearScript == null:
		printerr("T-0185 FAIL: could not load signal_tower/chain_tear.gd")
		quit(1)
		return
	if ChainScript == null:
		printerr("T-0185 FAIL: could not load signal_tower/signal_tower_chain.gd")
		quit(1)
		return

	# ── Instantiate chain ─────────────────────────────────────────────────────
	var chain: Object = ChainScript.new()

	# ── Room count ────────────────────────────────────────────────────────────
	var all_tags: Array = chain.get_all_tags()
	if all_tags.size() != 7:
		failures.append("expected 7 rooms, got %d" % all_tags.size())

	# ── All seven anchor tags present ─────────────────────────────────────────
	var expected_tags: Array[String] = [
		"signal_tower.ground_relay",
		"signal_tower.records_room",
		"signal_tower.power_substation",
		"signal_tower.equipment_floor",
		"signal_tower.storage_cache",
		"signal_tower.antenna_shaft",
		"signal_tower.broadcast_deck",
	]
	for tag: String in expected_tags:
		if not all_tags.has(tag):
			failures.append("missing anchor tag: %s" % tag)

	# ── Room-type taxonomy: roles ─────────────────────────────────────────────
	# Climax and Tear are system-facing (own declared tags); Gate/Hazard/Transit
	# are author-facing roles on named room tags. (16 §1)

	var ground_relay: Object = chain.get_room("signal_tower.ground_relay")
	if ground_relay == null:
		failures.append("ground_relay room missing")
	else:
		if not ground_relay.has_role("TRANSIT"):
			failures.append("ground_relay should have TRANSIT role")
		if ground_relay.has_role("HAZARD"):
			failures.append("ground_relay should not have HAZARD role (no entity at entry)")

	var records_room: Object = chain.get_room("signal_tower.records_room")
	if records_room == null:
		failures.append("records_room missing")
	else:
		if not records_room.has_role("CLIMAX"):
			failures.append("records_room must have CLIMAX role (11 §7)")
		if not records_room.has_role("GATE"):
			failures.append("records_room must have GATE role (puzzle-locked entry)")
		if not records_room.puzzle_locked:
			failures.append("records_room.puzzle_locked must be true")

	var power_substation: Object = chain.get_room("signal_tower.power_substation")
	if power_substation == null:
		failures.append("power_substation missing")
	else:
		if not power_substation.has_role("GATE"):
			failures.append("power_substation must have GATE role (breaker puzzle)")
		if not power_substation.has_role("HAZARD"):
			failures.append("power_substation must have HAZARD role (Watcher)")

	var equipment_floor: Object = chain.get_room("signal_tower.equipment_floor")
	if equipment_floor == null:
		failures.append("equipment_floor missing")
	else:
		if not equipment_floor.has_role("HAZARD"):
			failures.append("equipment_floor must have HAZARD role (Sound)")

	var storage_cache: Object = chain.get_room("signal_tower.storage_cache")
	if storage_cache == null:
		failures.append("storage_cache missing")
	else:
		if not storage_cache.has_role("TRANSIT"):
			failures.append("storage_cache must have TRANSIT role (optional branch)")

	var antenna_shaft: Object = chain.get_room("signal_tower.antenna_shaft")
	if antenna_shaft == null:
		failures.append("antenna_shaft missing")
	else:
		if not antenna_shaft.has_role("HAZARD"):
			failures.append("antenna_shaft must have HAZARD role (Still Air)")

	var broadcast_deck: Object = chain.get_room("signal_tower.broadcast_deck")
	if broadcast_deck == null:
		failures.append("broadcast_deck missing")
	else:
		if not broadcast_deck.has_role("TEAR"):
			failures.append("broadcast_deck must have TEAR role (chain tear)")

	# ── Exactly one Climax, one Tear across all rooms ─────────────────────────
	var climax_count: int = 0
	var tear_count: int = 0
	for tag: String in all_tags:
		var room: Object = chain.get_room(tag)
		if room == null:
			continue
		if room.has_role("CLIMAX"):
			climax_count += 1
		if room.has_role("TEAR"):
			tear_count += 1
	if climax_count > 1:
		failures.append("at most 1 Climax room per archetype (16 §1), found %d" % climax_count)
	if tear_count != 1:
		failures.append("exactly 1 Tear per archetype (16 §2), found %d" % tear_count)

	# ── Three entities, one sensor each ──────────────────────────────────────
	var entity_rooms: Array[String] = [
		"signal_tower.power_substation",    # Watcher — sight cone
		"signal_tower.equipment_floor",     # Sound — sound radius
		"signal_tower.antenna_shaft",       # Still Air — proximity/patrol
	]
	var sensor_types_seen: Array[String] = []
	for etag: String in entity_rooms:
		var eroom: Object = chain.get_room(etag)
		if eroom == null:
			failures.append("entity room %s missing" % etag)
			continue
		if not eroom.has_entity:
			failures.append("room %s must have exactly one entity" % etag)
			continue
		var sensor_type: String = eroom.get_entity_sensor_type()
		if sensor_types_seen.has(sensor_type):
			failures.append("sensor type '%s' appears on more than one entity (11 §1 prohibits combining)" % sensor_type)
		sensor_types_seen.append(sensor_type)

	if sensor_types_seen.size() == 3:
		if not sensor_types_seen.has("SIGHT_CONE"):
			failures.append("no SIGHT_CONE entity found (Watcher required, 14 §3)")
		if not sensor_types_seen.has("SOUND_RADIUS"):
			failures.append("no SOUND_RADIUS entity found (Sound required, 14 §3)")
		if not sensor_types_seen.has("PROXIMITY_PATROL"):
			failures.append("no PROXIMITY_PATROL entity found (Still Air required, 14 §3)")

	# ── Non-entity rooms must not have entities ───────────────────────────────
	var non_entity_tags: Array[String] = [
		"signal_tower.ground_relay",
		"signal_tower.records_room",
		"signal_tower.storage_cache",
		"signal_tower.broadcast_deck",
	]
	for netag: String in non_entity_tags:
		var neroom: Object = chain.get_room(netag)
		if neroom == null:
			continue
		if neroom.has_entity:
			failures.append("room %s must not have an entity" % netag)

	# ── Sensor parameters match 14 §10 first-pass table ──────────────────────
	var sensor_params: Object = EntitySensorScript.new()
	var watcher_angle: float = sensor_params.get_watcher_cone_angle_deg()
	if not is_equal_approx(watcher_angle, 90.0):
		failures.append("Watcher cone angle should be 90 deg (14 §10), got %f" % watcher_angle)
	var watcher_range: float = sensor_params.get_watcher_cone_range_tiles()
	if not is_equal_approx(watcher_range, 6.0):
		failures.append("Watcher cone range should be 6 tiles (14 §10), got %f" % watcher_range)
	var watcher_pass: float = sensor_params.get_watcher_sweep_pass_sec()
	if not is_equal_approx(watcher_pass, 4.0):
		failures.append("Watcher sweep pass should be 4s (14 §10), got %f" % watcher_pass)
	var watcher_pause: float = sensor_params.get_watcher_sweep_pause_sec()
	if not is_equal_approx(watcher_pause, 2.0):
		failures.append("Watcher sweep pause should be 2s (14 §10), got %f" % watcher_pause)
	var sound_walk: float = sensor_params.get_sound_radius_walk_tiles()
	if sound_walk < 1.0 or sound_walk > 2.0:
		failures.append("Sound walk radius should be 1–2 tiles (14 §10), got %f" % sound_walk)
	var sound_run: float = sensor_params.get_sound_radius_run_tiles()
	if not is_equal_approx(sound_run, 5.0):
		failures.append("Sound run radius should be 5 tiles (14 §10), got %f" % sound_run)
	var still_air_lap: float = sensor_params.get_still_air_lap_sec()
	if still_air_lap < 20.0 or still_air_lap > 30.0:
		failures.append("Still Air lap should be 20–30s (14 §10), got %f" % still_air_lap)
	var still_air_catch: float = sensor_params.get_still_air_catch_radius_tiles()
	if not is_equal_approx(still_air_catch, 1.5):
		failures.append("Still Air catch radius should be 1.5 tiles (14 §10), got %f" % still_air_catch)

	# ── Chain tear: crossing without key is rejected ──────────────────────────
	var tear: Object = ChainTearScript.new()
	var empty_inv: Array[String] = []
	var reject_result: String = tear.attempt_cross(empty_inv)
	if reject_result.is_empty():
		failures.append("chain tear must reject crossing with no inventory (T-0180 coverage)")

	var no_key_inv: Array[String] = ["relay_fuse", "copper_coil"]
	var reject_no_key: String = tear.attempt_cross(no_key_inv)
	if reject_no_key.is_empty():
		failures.append("chain tear must reject crossing with inventory lacking resonance_key")

	# ── Chain tear: crossing with key succeeds ────────────────────────────────
	var key_inv: Array[String] = ["relay_fuse", "resonance_key"]
	var accept_result: String = tear.attempt_cross(key_inv)
	if not accept_result.is_empty():
		failures.append("chain tear must accept crossing when resonance_key is held, got: %s" % accept_result)
	if not tear.is_open:
		failures.append("tear must be open after first successful crossing")
	if key_inv.has("resonance_key"):
		failures.append("resonance_key must be transferred (removed from inventory) after crossing")

	# ── Chain tear: re-crossing an open tear needs no key ────────────────────
	var second_inv: Array[String] = ["copper_coil"]
	var reopen_result: String = tear.attempt_cross(second_inv)
	if not reopen_result.is_empty():
		failures.append("open tear must allow re-crossing without key, got: %s" % reopen_result)

	# ── Records Room branch is optional — player can reach Broadcast Deck ─────
	# The critical path is Ground Relay -> Power Substation -> Equipment Floor
	# -> Antenna Shaft -> Broadcast Deck. Records Room branches off Ground Relay.
	# The chain must not assume Records Room was visited to reach Broadcast Deck.
	if not chain.critical_path_excludes_records_room():
		failures.append("Records Room must be a branch (not on critical path) — chain silently assumes branch was visited")

	# ── Chroma shader: file exists with required uniform declarations ─────────
	var shader_text: String = FileAccess.get_file_as_string("res://shaders/chroma.gdshader")
	if shader_text.is_empty():
		failures.append("chroma.gdshader not found or empty (T-0121 deliverable)")
	else:
		if not shader_text.contains("origin_palette"):
			failures.append("chroma.gdshader must declare 'origin_palette' uniform (T-0121)")
		if not shader_text.contains("collapse_proximity"):
			failures.append("chroma.gdshader must declare 'collapse_proximity' uniform (T-0121)")
		if not shader_text.contains("lut"):
			failures.append("chroma.gdshader must reference a 'lut' texture uniform (T-0121)")

	# ── Sight-cone detection logic ────────────────────────────────────────────
	# Watcher at origin facing east (0 deg), cone 90 deg / 6 tiles.
	# Player directly ahead at 3 tiles should be detected.
	var watcher_sensor: Object = EntitySensorScript.new()
	watcher_sensor.init_sight_cone("The Watcher")
	var detected_ahead: bool = watcher_sensor.is_detected(
		Vector2(3.0, 0.0),   # player 3 tiles east
		Vector2(0.0, 0.0),   # entity at origin
		0.0,                  # facing east
		"walk",
		0.0
	)
	if not detected_ahead:
		failures.append("Watcher must detect player directly ahead within 6 tiles")

	# Player behind entity (180 deg) should NOT be detected by sight cone.
	var detected_behind: bool = watcher_sensor.is_detected(
		Vector2(-3.0, 0.0),  # player 3 tiles west
		Vector2(0.0, 0.0),
		0.0,                  # facing east
		"walk",
		0.0
	)
	if detected_behind:
		failures.append("Watcher must NOT detect player directly behind (outside cone)")

	# Player 7 tiles ahead (beyond range) should NOT be detected.
	var detected_far: bool = watcher_sensor.is_detected(
		Vector2(7.0, 0.0),
		Vector2(0.0, 0.0),
		0.0,
		"walk",
		0.0
	)
	if detected_far:
		failures.append("Watcher must NOT detect player beyond 6-tile cone range")

	# ── Sound-radius detection logic ──────────────────────────────────────────
	var sound_sensor: Object = EntitySensorScript.new()
	sound_sensor.init_sound_radius("The Sound")

	# Running player at 4 tiles should be detected.
	var detected_run: bool = sound_sensor.is_detected(
		Vector2(4.0, 0.0),
		Vector2(0.0, 0.0),
		0.0,
		"run",
		0.0
	)
	if not detected_run:
		failures.append("Sound must detect running player at 4 tiles (radius 5)")

	# Walking player at 1.2 tiles should NOT be detected (walk radius ~1.5).
	var walking_close: bool = sound_sensor.is_detected(
		Vector2(0.8, 0.0),   # 0.8 tiles away — within walk radius
		Vector2(0.0, 0.0),
		0.0,
		"walk",
		0.0
	)
	if not walking_close:
		failures.append("Sound must detect walking player within walk radius")

	# Walking player at 3 tiles should NOT be detected (walk radius ~1.5).
	var walking_far: bool = sound_sensor.is_detected(
		Vector2(3.0, 0.0),
		Vector2(0.0, 0.0),
		0.0,
		"walk",
		0.0
	)
	if walking_far:
		failures.append("Sound must NOT detect walking player at 3 tiles (beyond walk radius)")

	# ── Proximity/patrol detection logic ──────────────────────────────────────
	var still_air_sensor: Object = EntitySensorScript.new()
	still_air_sensor.init_proximity_patrol("The Still Air")

	# Player within catch radius should be detected.
	var detected_close: bool = still_air_sensor.is_detected(
		Vector2(1.0, 0.0),
		Vector2(0.0, 0.0),
		0.0,
		"walk",
		0.5
	)
	if not detected_close:
		failures.append("Still Air must detect player within 1.5-tile catch radius")

	# Player outside catch radius should NOT be detected (no LOS, pure distance).
	var detected_outside: bool = still_air_sensor.is_detected(
		Vector2(3.0, 0.0),
		Vector2(0.0, 0.0),
		0.0,
		"walk",
		0.5
	)
	if detected_outside:
		failures.append("Still Air must NOT detect player beyond 1.5-tile catch radius")

	# ── Report ────────────────────────────────────────────────────────────────
	if failures.is_empty():
		print("T-0185 PASS: Signal Tower chain (7 rooms, 3 entities, tear, chroma shader) verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0185 FAIL: %s" % f)
		quit(1)
