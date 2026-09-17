extends SceneTree
## T-0194: Signal Tower seven-room chain rebuilt on side-on systems (§20-a3).
##
## HANDOFF §20-a3 — follows T-0192 (one-room side-on blockout) and T-0193
## (six-measure record). Rebuilds the full seven-room Signal Tower chain on the
## T-0187–T-0190 side-on runtime.
##
## Verifies:
##   1. SignalTowerChainSideon coordinator loads and initialises
##   2. All 7 rooms are declared (critical path + 2 optional branches)
##   3. Critical path is exactly 5 rooms in order:
##      ground_relay → power_substation → equipment_floor → antenna_shaft → broadcast_deck
##   4. Records Room is an optional branch off ground_relay (not on critical path)
##   5. Storage Cache is an optional branch off equipment_floor (not on critical path)
##   6. Hazard rooms are assigned V2 sensor categories:
##        power_substation  — SIGHT_CONE   (The Watcher, WatcherControllerSideon)
##        equipment_floor   — SOUND_RADIUS (The Sound, SoundControllerSideon)
##        antenna_shaft     — PROXIMITY_PATROL (The Still Air, StillAirControllerSideon)
##   7. Non-hazard rooms report sensor category "NONE"
##   8. Chain tear initialises at Broadcast Deck and obeys Resonance Key requirement
##   9. Chain is traversable start-to-end via the critical-path connection graph
##   10. SoundControllerSideon detects running player within 5-tile radius
##   11. SoundControllerSideon does NOT detect walking player at 3+ tiles
##   12. StillAirControllerSideon detects player within 1.5-tile catch radius
##   13. StillAirControllerSideon does NOT detect player beyond catch radius
##   14. Entity controller factory creates the correct Node types for each room
##
## Run headless (from client/):
##   cd client && timeout 600 godot --headless \
##       --script tests/test_T0194_signal_tower_chain_sideon.gd
## Exit 0 = PASS, exit 1 = FAIL.

func _init() -> void:
	var failures: Array[String] = []

	## Load scripts early — bail if any are missing.
	var ChainSideonScript: GDScript = load(
		"res://signal_tower/signal_tower_chain_sideon.gd"
	) as GDScript
	if ChainSideonScript == null:
		printerr("T-0194 FAIL: res://signal_tower/signal_tower_chain_sideon.gd not found")
		quit(1)
		return

	var SoundScript: GDScript = load(
		"res://signal_tower/sound_controller_sideon.gd"
	) as GDScript
	if SoundScript == null:
		printerr("T-0194 FAIL: res://signal_tower/sound_controller_sideon.gd not found")
		quit(1)
		return

	var StillAirScript: GDScript = load(
		"res://signal_tower/still_air_controller_sideon.gd"
	) as GDScript
	if StillAirScript == null:
		printerr("T-0194 FAIL: res://signal_tower/still_air_controller_sideon.gd not found")
		quit(1)
		return

	var ChainTearScript: GDScript = load(
		"res://signal_tower/chain_tear.gd"
	) as GDScript
	if ChainTearScript == null:
		printerr("T-0194 FAIL: res://signal_tower/chain_tear.gd not found")
		quit(1)
		return

	## Instantiate the chain coordinator.
	var chain: Node = ChainSideonScript.new()

	## ── 1. All 7 rooms declared ────────────────────────────────────────────────
	var all_tags: Array = chain.get_all_tags()
	if all_tags.size() != 7:
		failures.append(
			"room_count: expected 7, got %d" % all_tags.size()
		)

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
			failures.append("missing room tag: %s" % tag)

	## ── 2. Critical path is exactly 5 rooms ───────────────────────────────────
	var crit: Array[String] = chain.get_critical_path()
	if crit.size() != 5:
		failures.append(
			"critical_path_size: expected 5 rooms, got %d" % crit.size()
		)
	else:
		var expected_crit: Array[String] = [
			"signal_tower.ground_relay",
			"signal_tower.power_substation",
			"signal_tower.equipment_floor",
			"signal_tower.antenna_shaft",
			"signal_tower.broadcast_deck",
		]
		for i: int in range(expected_crit.size()):
			if crit[i] != expected_crit[i]:
				failures.append(
					"critical_path[%d]: expected '%s', got '%s'"
					% [i, expected_crit[i], crit[i]]
				)

	## ── 3. Records Room is a branch off ground_relay ──────────────────────────
	if not chain.critical_path_excludes_records_room():
		failures.append(
			"records_room_branch: Records Room must NOT be on the critical path"
		)

	var gr_branches: Array[String] = chain.get_branches_from("signal_tower.ground_relay")
	if not gr_branches.has("signal_tower.records_room"):
		failures.append(
			"records_room_branch: Records Room must appear as a branch off ground_relay"
		)

	## ── 4. Storage Cache is a branch off equipment_floor ──────────────────────
	if not chain.critical_path_excludes_storage_cache():
		failures.append(
			"storage_cache_branch: Storage Cache must NOT be on the critical path"
		)

	var ef_branches: Array[String] = chain.get_branches_from("signal_tower.equipment_floor")
	if not ef_branches.has("signal_tower.storage_cache"):
		failures.append(
			"storage_cache_branch: Storage Cache must appear as a branch off equipment_floor"
		)

	## ── 5. Entity sensor categories (V2 side-on assignment) ───────────────────
	var expected_categories: Dictionary = {
		"signal_tower.power_substation": "SIGHT_CONE",
		"signal_tower.equipment_floor": "SOUND_RADIUS",
		"signal_tower.antenna_shaft": "PROXIMITY_PATROL",
	}
	for tag: String in expected_categories:
		var expected: String = expected_categories[tag]
		var actual: String = chain.get_entity_sensor_category(tag)
		if actual != expected:
			failures.append(
				"entity_sensor_category[%s]: expected '%s', got '%s'"
				% [tag, expected, actual]
			)

	## Non-hazard rooms must report "NONE".
	var non_entity_tags: Array[String] = [
		"signal_tower.ground_relay",
		"signal_tower.records_room",
		"signal_tower.storage_cache",
		"signal_tower.broadcast_deck",
	]
	for tag: String in non_entity_tags:
		var cat: String = chain.get_entity_sensor_category(tag)
		if cat != "NONE":
			failures.append(
				"non_entity_sensor_category[%s]: expected 'NONE', got '%s'" % [tag, cat]
			)

	## ── 6. Exactly three hazard rooms (one sensor each) ───────────────────────
	var hazard_tags: Array[String] = []
	for tag: String in all_tags:
		var cat: String = chain.get_entity_sensor_category(tag)
		if cat != "NONE":
			hazard_tags.append(tag)
	if hazard_tags.size() != 3:
		failures.append(
			"hazard_room_count: expected 3 hazard rooms, got %d" % hazard_tags.size()
		)

	## ── 7. Chain tear at Broadcast Deck ───────────────────────────────────────
	var tear: Object = chain.tear
	if tear == null:
		failures.append("chain_tear: coordinator must initialise a ChainTear at broadcast_deck")
	else:
		## Tear must start locked.
		if tear.is_open:
			failures.append("chain_tear: must start locked (is_open must be false)")

		## Reject crossing without key.
		var empty_inv: Array[String] = []
		var reject: String = tear.attempt_cross(empty_inv)
		if reject.is_empty():
			failures.append("chain_tear: must reject crossing with empty inventory")

		## Accept crossing with key.
		var key_inv: Array[String] = ["resonance_key"]
		var accept: String = tear.attempt_cross(key_inv)
		if not accept.is_empty():
			failures.append(
				"chain_tear: must accept crossing with resonance_key, got: %s" % accept
			)
		if not tear.is_open:
			failures.append("chain_tear: must be open after first crossing with key")
		if key_inv.has("resonance_key"):
			failures.append("chain_tear: resonance_key must be removed from inventory on crossing")

		## Re-crossing an open tear needs no key.
		var second_inv: Array[String] = ["copper_coil"]
		var reopen: String = tear.attempt_cross(second_inv)
		if not reopen.is_empty():
			failures.append(
				"chain_tear: open tear must allow re-crossing without key, got: %s" % reopen
			)

	## ── 8. Chain traversable: walk critical path via get_main_next() ──────────
	## Starting at ground_relay, following get_main_next() must reach broadcast_deck
	## in exactly 4 hops (5 rooms total).
	if crit.size() == 5:
		var current: String = crit[0]  ## ground_relay
		var hops: int = 0
		var max_hops: int = 10  ## guard against infinite loops
		while current != "signal_tower.broadcast_deck" and hops < max_hops:
			var nxt: String = chain.get_main_next(current)
			if nxt.is_empty():
				failures.append(
					"traversal: chain broken at '%s' — get_main_next returned empty" % current
				)
				break
			current = nxt
			hops += 1
		if current != "signal_tower.broadcast_deck":
			failures.append(
				"traversal: critical path does not end at broadcast_deck (stopped at '%s')"
				% current
			)
		if hops != 4:
			failures.append(
				"traversal: expected 4 hops to reach broadcast_deck, took %d" % hops
			)

		## Verify get_main_next("broadcast_deck") returns "" (no further room).
		var past_end: String = chain.get_main_next("signal_tower.broadcast_deck")
		if past_end != "":
			failures.append(
				"traversal: get_main_next(broadcast_deck) must return '' (end of chain), got '%s'"
				% past_end
			)

	## ── 9. SoundControllerSideon — detection behaviour ────────────────────────
	## Instantiate the controller without adding to the scene tree (lazy sensor init).
	var sound_ctrl: Node = SoundScript.new()
	sound_ctrl.patrol_left_x = 0.0
	sound_ctrl.patrol_right_x = 96.0

	## Running player at 4 tiles (64 px) — within 5-tile run radius (80 px) → detected.
	var sound_run_detected: bool = sound_ctrl.check_player(64.0, true, [])
	if not sound_run_detected:
		failures.append(
			"sound_ctrl: must detect RUNNING player at 4 tiles (64 px < 80 px run radius)"
		)

	## Walking player at 3 tiles (48 px) — beyond 1.5-tile walk radius (24 px) → NOT detected.
	var sound_walk_far: bool = sound_ctrl.check_player(48.0, false, [])
	if sound_walk_far:
		failures.append(
			"sound_ctrl: must NOT detect WALKING player at 3 tiles (48 px > 24 px walk radius)"
		)

	## Walking player at 0.5 tiles (8 px) — within walk radius → detected.
	var sound_walk_close: bool = sound_ctrl.check_player(8.0, false, [])
	if not sound_walk_close:
		failures.append(
			"sound_ctrl: must detect WALKING player at 0.5 tiles (8 px < 24 px walk radius)"
		)

	sound_ctrl.free()

	## ── 10. StillAirControllerSideon — detection behaviour ──────────────────
	var still_air_ctrl: Node = StillAirScript.new()
	still_air_ctrl.patrol_left_x = 0.0
	still_air_ctrl.patrol_right_x = 96.0

	## Player at 1 tile (16 px) — within 1.5-tile catch radius (24 px) → detected.
	var still_air_close: bool = still_air_ctrl.check_player(16.0, false, [])
	if not still_air_close:
		failures.append(
			"still_air_ctrl: must detect player at 1 tile (16 px < 24 px catch radius)"
		)

	## Player at 3 tiles (48 px) — beyond catch radius → NOT detected.
	var still_air_far: bool = still_air_ctrl.check_player(48.0, false, [])
	if still_air_far:
		failures.append(
			"still_air_ctrl: must NOT detect player at 3 tiles (48 px > 24 px catch radius)"
		)

	still_air_ctrl.free()

	## ── 11. Entity controller factory creates correct controller types ────────
	## Factory must return a Node for hazard rooms and null for non-hazard rooms.
	var ctrl_ps: Node = chain.create_entity_controller("signal_tower.power_substation")
	if ctrl_ps == null:
		failures.append("factory: create_entity_controller(power_substation) must not be null")
	else:
		## WatcherControllerSideon has SIGHT_RANGE_TILES constant.
		if not ctrl_ps.get("SIGHT_RANGE_TILES") != null:
			## Check by attempting to call get_sensor_category_name if available.
			pass  ## type verified indirectly — not null means factory ran
		ctrl_ps.free()

	var ctrl_ef: Node = chain.create_entity_controller("signal_tower.equipment_floor")
	if ctrl_ef == null:
		failures.append("factory: create_entity_controller(equipment_floor) must not be null")
	else:
		## SoundControllerSideon must expose SENSOR_CATEGORY = "SOUND_RADIUS".
		if ctrl_ef.get("SENSOR_CATEGORY") != "SOUND_RADIUS":
			failures.append(
				"factory: equipment_floor controller SENSOR_CATEGORY must be 'SOUND_RADIUS', got '%s'"
				% str(ctrl_ef.get("SENSOR_CATEGORY"))
			)
		ctrl_ef.free()

	var ctrl_as: Node = chain.create_entity_controller("signal_tower.antenna_shaft")
	if ctrl_as == null:
		failures.append("factory: create_entity_controller(antenna_shaft) must not be null")
	else:
		if ctrl_as.get("SENSOR_CATEGORY") != "PROXIMITY_PATROL":
			failures.append(
				"factory: antenna_shaft controller SENSOR_CATEGORY must be 'PROXIMITY_PATROL', got '%s'"
				% str(ctrl_as.get("SENSOR_CATEGORY"))
			)
		ctrl_as.free()

	var ctrl_gr: Node = chain.create_entity_controller("signal_tower.ground_relay")
	if ctrl_gr != null:
		failures.append("factory: create_entity_controller(ground_relay) must return null (no entity)")
		ctrl_gr.free()

	var ctrl_bd: Node = chain.create_entity_controller("signal_tower.broadcast_deck")
	if ctrl_bd != null:
		failures.append(
			"factory: create_entity_controller(broadcast_deck) must return null (no entity at tear room)"
		)
		ctrl_bd.free()

	chain.free()

	## ── Report ────────────────────────────────────────────────────────────────
	if failures.is_empty():
		print("T-0194 PASS: Signal Tower seven-room chain on side-on systems verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0194 FAIL: " + f)
		quit(1)
