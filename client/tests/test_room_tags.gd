extends SceneTree
## T-0181: Room-type roles as authoring metadata.
##
## Verifies:
##   - Gate+Hazard dual-role room: both roles independently queryable via
##     rooms_with_role(); neither hides the other (16-level-design.md §1).
##   - Archetype missing a declared Climax anchor: validate_required_anchors()
##     returns an error rather than silently passing (INV-12-class check).
##   - Archetype missing its Tear anchor: validate() returns an error; Tear is
##     unconditionally required, exactly one per archetype (16 §2).
##   - Zero Gate rooms: not a hard error (no hard minimum), but audit_gate_count()
##     must produce a non-empty, legible report — not silent (16 §2 edge case).
##   - Signal Tower canonical definition: satisfies all constraints including
##     Tear=1, Climax=1, Gate>=1, and signal_tower.climax as its own dedicated
##     anchor tag co-located with records_room/music_cue (16 §1 retroactive fix).
##
## Run headless:
##   godot --headless --script tests/test_room_tags.gd
## from client/. Exit 0 on PASS, 1 on any failure.

const RoomTagDef := preload("res://room_tag_def.gd")
const ArchetypeTagSet := preload("res://archetype_tag_set.gd")


func _init() -> void:
	var failures: Array[String] = []

	failures += _test_dual_role_room()
	failures += _test_missing_climax_fails_validation()
	failures += _test_missing_tear_fails_validation()
	failures += _test_zero_gate_auditable()
	failures += _test_signal_tower_valid()

	if failures.is_empty():
		print("T-0181 PASS: room-type roles authoring metadata verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0181 FAIL: " + f)
		quit(1)


## ── Test: Gate+Hazard dual-role room ─────────────────────────────────────────
## Power Substation carries both Gate and Hazard simultaneously (16 §1 example).
## Both roles must be independently queryable; neither must suppress the other.
func _test_dual_role_room() -> Array[String]:
	var failures: Array[String] = []

	var substation: Object = RoomTagDef.new(
		"power_substation",
		RoomTagDef.AnchorKind.NAMED,
		RoomTagDef.RoomRole.GATE | RoomTagDef.RoomRole.HAZARD
	)
	var climax: Object = RoomTagDef.new("climax", RoomTagDef.AnchorKind.CLIMAX, RoomTagDef.RoomRole.NONE)
	var tear: Object = RoomTagDef.new("tear", RoomTagDef.AnchorKind.TEAR, RoomTagDef.RoomRole.NONE)
	var tag_set: Object = ArchetypeTagSet.new(6, [substation, climax, tear])

	# has_role() on the fixture itself.
	if not substation.has_role(RoomTagDef.RoomRole.GATE):
		failures.append("dual_role: has_role(GATE) returned false on Gate|Hazard room")
	if not substation.has_role(RoomTagDef.RoomRole.HAZARD):
		failures.append("dual_role: has_role(HAZARD) returned false on Gate|Hazard room")
	if substation.has_role(RoomTagDef.RoomRole.TRANSIT):
		failures.append("dual_role: has_role(TRANSIT) returned true on Gate|Hazard room — unexpected")

	# rooms_with_role(GATE) must return the substation.
	var gates: Array = tag_set.rooms_with_role(RoomTagDef.RoomRole.GATE)
	if gates.size() != 1:
		failures.append(
			"dual_role: rooms_with_role(GATE) returned %d rooms, expected 1" % gates.size()
		)
	elif gates[0].tag_name != "power_substation":
		failures.append(
			"dual_role: rooms_with_role(GATE)[0] tag_name is '%s', expected 'power_substation'"
			% gates[0].tag_name
		)

	# rooms_with_role(HAZARD) must also return the substation (not hidden by GATE).
	var hazards: Array = tag_set.rooms_with_role(RoomTagDef.RoomRole.HAZARD)
	if hazards.size() != 1:
		failures.append(
			"dual_role: rooms_with_role(HAZARD) returned %d rooms, expected 1" % hazards.size()
		)
	elif hazards[0].tag_name != "power_substation":
		failures.append(
			"dual_role: rooms_with_role(HAZARD)[0] tag_name is '%s', expected 'power_substation'"
			% hazards[0].tag_name
		)

	return failures


## ── Test: missing Climax anchor detected by validate_required_anchors ─────────
## validate() alone passes (Climax is at most 1, not required at the core level).
## validate_required_anchors([CLIMAX]) must fail when Climax is absent — same
## INV-12-class check that other declared anchor tags use.
func _test_missing_climax_fails_validation() -> Array[String]:
	var failures: Array[String] = []

	var tear: Object = RoomTagDef.new("tear", RoomTagDef.AnchorKind.TEAR, RoomTagDef.RoomRole.NONE)
	var room: Object = RoomTagDef.new(
		"ground_relay", RoomTagDef.AnchorKind.NAMED, RoomTagDef.RoomRole.TRANSIT
	)
	# No CLIMAX tag — simulates a broken variant of an archetype that declares one.
	var tag_set: Object = ArchetypeTagSet.new(6, [tear, room])

	# Core validate() must pass (Tear=1 ✓, Climax 0 ≤ 1 ✓).
	var core_errors: Array = tag_set.validate()
	if not core_errors.is_empty():
		failures.append(
			"missing_climax: validate() unexpectedly failed: %s" % str(core_errors)
		)

	# validate_required_anchors([CLIMAX]) must report missing anchor.
	var anchor_errors: Array = tag_set.validate_required_anchors([RoomTagDef.AnchorKind.CLIMAX])
	if anchor_errors.is_empty():
		failures.append(
			"missing_climax: validate_required_anchors([CLIMAX]) returned no errors — expected failure"
		)

	return failures


## ── Test: missing Tear anchor fails core validate ─────────────────────────────
## Tear is unconditionally required, exactly one per archetype (16 §2).
## validate() must return an error for any tag set with Tear count != 1.
func _test_missing_tear_fails_validation() -> Array[String]:
	var failures: Array[String] = []

	var climax: Object = RoomTagDef.new("climax", RoomTagDef.AnchorKind.CLIMAX, RoomTagDef.RoomRole.NONE)
	var room: Object = RoomTagDef.new(
		"ground_relay", RoomTagDef.AnchorKind.NAMED, RoomTagDef.RoomRole.TRANSIT
	)
	# No TEAR tag — must fail core validation.
	var tag_set: Object = ArchetypeTagSet.new(6, [climax, room])

	var errors: Array = tag_set.validate()
	if errors.is_empty():
		failures.append(
			"missing_tear: validate() returned no errors — expected Tear-count error"
		)

	return failures


## ── Test: zero Gate rooms is auditable, not silent ───────────────────────────
## Gate has no hard minimum (16 §2); 0-Gate archetypes are valid.
## has_gate() must return false and audit_gate_count() must produce a legible,
## non-empty report so authors can distinguish deliberate 0-Gate archetypes
## from ones that simply forgot to tag a room.
func _test_zero_gate_auditable() -> Array[String]:
	var failures: Array[String] = []

	var climax: Object = RoomTagDef.new("climax", RoomTagDef.AnchorKind.CLIMAX, RoomTagDef.RoomRole.NONE)
	var tear: Object = RoomTagDef.new("tear", RoomTagDef.AnchorKind.TEAR, RoomTagDef.RoomRole.NONE)
	var transit: Object = RoomTagDef.new(
		"lobby", RoomTagDef.AnchorKind.NAMED, RoomTagDef.RoomRole.TRANSIT
	)
	var tag_set: Object = ArchetypeTagSet.new(6, [climax, tear, transit])

	# validate() must pass — 0 Gate rooms is not a hard error.
	var errors: Array = tag_set.validate()
	if not errors.is_empty():
		failures.append(
			"zero_gate: validate() failed on zero-Gate archetype (must be valid): %s"
			% str(errors)
		)

	# has_gate() must return false.
	if tag_set.has_gate():
		failures.append("zero_gate: has_gate() returned true on tag set with no Gate rooms")

	# audit_gate_count() must be non-empty (visible, not silent).
	var audit: String = tag_set.audit_gate_count()
	if audit.is_empty():
		failures.append("zero_gate: audit_gate_count() returned empty string — must be non-empty")

	# The report must make the count legible (mention "0" or "zero").
	if not audit.to_lower().contains("0") and not audit.to_lower().contains("zero"):
		failures.append(
			"zero_gate: audit_gate_count() did not mention the count: '%s'" % audit
		)

	return failures


## ── Test: Signal Tower canonical definition is fully valid ───────────────────
## signal_tower.climax must exist as its own dedicated CLIMAX anchor tag,
## distinct from records_room (16 §1 retroactive fix).
## Power Substation must carry both Gate and Hazard roles (16 §5 worked example).
func _test_signal_tower_valid() -> Array[String]:
	var failures: Array[String] = []

	const SignalTowerTagSet := preload("res://archetypes/signal_tower_tag_set.gd")
	var tag_set: Object = SignalTowerTagSet.make()

	# Core invariants: exactly one Tear, at most one Climax/MusicCue.
	var core_errors: Array = tag_set.validate()
	if not core_errors.is_empty():
		failures.append("signal_tower: validate() failed: %s" % str(core_errors))

	# signal_tower declares both Tear and Climax — both must be present.
	var anchor_errors: Array = tag_set.validate_required_anchors([
		RoomTagDef.AnchorKind.TEAR,
		RoomTagDef.AnchorKind.CLIMAX,
	])
	if not anchor_errors.is_empty():
		failures.append(
			"signal_tower: validate_required_anchors([TEAR, CLIMAX]) failed: %s"
			% str(anchor_errors)
		)

	# climax must be its own dedicated anchor tag (AnchorKind.CLIMAX), not a named room.
	var climax_anchor: Object = tag_set.find_anchor(RoomTagDef.AnchorKind.CLIMAX)
	if climax_anchor == null:
		failures.append(
			"signal_tower: no CLIMAX anchor found — signal_tower.climax must be a dedicated anchor"
		)
	elif climax_anchor.tag_name != "climax":
		failures.append(
			"signal_tower: CLIMAX anchor tag_name is '%s', expected 'climax'"
			% climax_anchor.tag_name
		)

	# tear must be its own dedicated anchor tag (AnchorKind.TEAR).
	var tear_anchor: Object = tag_set.find_anchor(RoomTagDef.AnchorKind.TEAR)
	if tear_anchor == null:
		failures.append(
			"signal_tower: no TEAR anchor found — signal_tower.tear must be a dedicated anchor"
		)
	elif tear_anchor.tag_name != "tear":
		failures.append(
			"signal_tower: TEAR anchor tag_name is '%s', expected 'tear'" % tear_anchor.tag_name
		)

	# signal_tower has Gate rooms (Records Room + Power Substation).
	if not tag_set.has_gate():
		failures.append("signal_tower: has_gate() returned false — expected at least one Gate room")

	# Power Substation must carry both Gate and Hazard (16 §5: "Gate + Hazard (sight-cone slot)").
	var gate_rooms: Array = tag_set.rooms_with_role(RoomTagDef.RoomRole.GATE)
	var substation: Object = null
	for r: Object in gate_rooms:
		if r.tag_name == "power_substation":
			substation = r
			break
	if substation == null:
		failures.append(
			"signal_tower: power_substation not found among Gate rooms"
		)
	elif not substation.has_role(RoomTagDef.RoomRole.HAZARD):
		failures.append(
			"signal_tower: power_substation missing Hazard role (16 §5 requires Gate+Hazard)"
		)

	return failures
