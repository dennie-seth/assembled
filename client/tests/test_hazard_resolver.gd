extends SceneTree
## T-0182: Hazard sensor-category slots — room declares category, entity rolled per-universe.
##
## A Hazard room declares only its sensor-category requirement (sight cone, sound radius,
## or proximity/patrol). The occupying entity is resolved per-universe by HazardResolver
## using EntityRoster, so the entity roster can grow later without any existing Hazard
## room needing re-authoring (16-level-design.md §3).
##
## Acceptance tests:
##   1. SIGHT_CONE room resolves to the Watcher without the room naming "watcher" directly.
##   2. All three categories resolve to an entity matching that sensor category.
##   3. Swapping which entity a category maps to (roster swap) requires zero change to
##      the HazardRoom's declared data.
##   4. When a category has multiple entities, different universe seeds yield different
##      entities — two universes' "same" Hazard room may intentionally differ (02-notes-system.md §4).
##
## Run headless:
##   godot --headless --script tests/test_hazard_resolver.gd
## from client/. Exit 0 on PASS, 1 on any failure.

const HazardRoom := preload("res://hazard_room.gd")
const EntityDef := preload("res://entity_def.gd")
const EntityRoster := preload("res://entity_roster.gd")
const HazardResolver := preload("res://hazard_resolver.gd")


func _init() -> void:
	var failures: Array[String] = []

	failures += _test_sight_cone_resolves_without_naming_watcher()
	failures += _test_all_categories_resolve_to_matching_entity()
	failures += _test_roster_swap_does_not_touch_room_data()
	failures += _test_multiple_entities_per_category_resolved_by_seed()

	if failures.is_empty():
		print("T-0182 PASS: Hazard sensor-category slots resolve correctly")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0182 FAIL: %s" % f)
		quit(1)


## Test 1: A HazardRoom with SIGHT_CONE resolves to the Watcher without the room's
## authored data containing any reference to the entity by name.
func _test_sight_cone_resolves_without_naming_watcher() -> Array[String]:
	var failures: Array[String] = []

	var room := HazardRoom.new()
	room.sensor_category = HazardRoom.SensorCategory.SIGHT_CONE

	# The room's authored data must not name the entity — only the category.
	# Stringify the enum value and confirm "watcher" is not in the room data.
	var room_data_str: String = str(room.sensor_category)
	if room_data_str.to_lower().contains("watcher"):
		failures.append(
			"sight_cone_no_name: room.sensor_category encodes 'watcher' — room is naming the entity directly"
		)

	var entity: EntityDef = HazardResolver.resolve(room, 0)
	if entity == null:
		failures.append("sight_cone_no_name: resolve() returned null for SIGHT_CONE")
		return failures

	if entity.entity_id != "watcher":
		failures.append(
			"sight_cone_no_name: expected entity_id='watcher', got '%s'" % entity.entity_id
		)

	if entity.sensor_category != HazardRoom.SensorCategory.SIGHT_CONE:
		failures.append(
			"sight_cone_no_name: resolved entity has category %d, expected SIGHT_CONE (%d)"
			% [entity.sensor_category, HazardRoom.SensorCategory.SIGHT_CONE]
		)

	return failures


## Test 2: Each sensor category resolves to an entity whose sensor_category
## matches the declared room category. Covers all three categories in the v1 roster.
func _test_all_categories_resolve_to_matching_entity() -> Array[String]:
	var failures: Array[String] = []

	var cases: Array[int] = [
		HazardRoom.SensorCategory.SIGHT_CONE,
		HazardRoom.SensorCategory.SOUND_RADIUS,
		HazardRoom.SensorCategory.PROXIMITY_PATROL,
	]

	for cat: int in cases:
		var room := HazardRoom.new()
		room.sensor_category = cat

		var entity: EntityDef = HazardResolver.resolve(room, 0)
		if entity == null:
			failures.append("all_categories: resolve() returned null for category %d" % cat)
			continue

		if entity.sensor_category != cat:
			failures.append(
				"all_categories: category %d resolved to entity with category %d"
				% [cat, entity.sensor_category]
			)

	return failures


## Test 3: Swapping which entity a category resolves to (by injecting a custom roster)
## requires zero change to the HazardRoom's declared data. The room is authored once;
## only the roster changes.
func _test_roster_swap_does_not_touch_room_data() -> Array[String]:
	var failures: Array[String] = []

	# Author the HazardRoom once — this data must remain unchanged throughout the test.
	var room := HazardRoom.new()
	room.sensor_category = HazardRoom.SensorCategory.SIGHT_CONE

	# Default roster: SIGHT_CONE → "watcher".
	var default_entity: EntityDef = HazardResolver.resolve(room, 0)
	if default_entity == null:
		failures.append("roster_swap: default resolve() returned null")
		return failures
	if default_entity.entity_id != "watcher":
		failures.append(
			"roster_swap: default roster did not resolve to 'watcher', got '%s'"
			% default_entity.entity_id
		)

	# Swapped roster: replace the SIGHT_CONE entity with a hypothetical "seeker".
	# The room's sensor_category stays untouched.
	var swapped_roster := EntityRoster.new()
	swapped_roster.register("seeker",    HazardRoom.SensorCategory.SIGHT_CONE,      "The Seeker")
	swapped_roster.register("sound",     HazardRoom.SensorCategory.SOUND_RADIUS,    "The Sound")
	swapped_roster.register("still_air", HazardRoom.SensorCategory.PROXIMITY_PATROL, "The Still Air")

	var swapped_entity: EntityDef = HazardResolver.resolve_with_roster(room, 0, swapped_roster)
	if swapped_entity == null:
		failures.append("roster_swap: swapped resolve() returned null")
		return failures
	if swapped_entity.entity_id != "seeker":
		failures.append(
			"roster_swap: swapped roster did not resolve to 'seeker', got '%s'"
			% swapped_entity.entity_id
		)

	# Confirm the room's authored data was never mutated.
	if room.sensor_category != HazardRoom.SensorCategory.SIGHT_CONE:
		failures.append("roster_swap: room.sensor_category was mutated — must remain SIGHT_CONE")

	return failures


## Test 4: When a category has multiple entities, different universe seeds resolve to
## different entities. This verifies that two different universes' "same" Hazard room
## may intentionally hold different entities once the roster grows past one-per-category
## (16-level-design.md §3, 02-notes-system.md §4) — this is by design, not a bug.
func _test_multiple_entities_per_category_resolved_by_seed() -> Array[String]:
	var failures: Array[String] = []

	# Build an expanded roster with two sight-cone entities.
	var expanded_roster := EntityRoster.new()
	expanded_roster.register("watcher", HazardRoom.SensorCategory.SIGHT_CONE, "The Watcher")
	expanded_roster.register("seeker",  HazardRoom.SensorCategory.SIGHT_CONE, "The Seeker")

	var room := HazardRoom.new()
	room.sensor_category = HazardRoom.SensorCategory.SIGHT_CONE

	var entity_a: EntityDef = HazardResolver.resolve_with_roster(room, 0, expanded_roster)
	var entity_b: EntityDef = HazardResolver.resolve_with_roster(room, 1, expanded_roster)

	if entity_a == null or entity_b == null:
		failures.append("multi_entity: resolve_with_roster returned null with expanded roster")
		return failures

	# Both resolved entities must belong to the declared category.
	if entity_a.sensor_category != HazardRoom.SensorCategory.SIGHT_CONE:
		failures.append("multi_entity: entity_a is not a SIGHT_CONE entity (category=%d)" % entity_a.sensor_category)
	if entity_b.sensor_category != HazardRoom.SensorCategory.SIGHT_CONE:
		failures.append("multi_entity: entity_b is not a SIGHT_CONE entity (category=%d)" % entity_b.sensor_category)

	# Seeds 0 and 1 must yield different entities when the roster has 2 entries.
	if entity_a.entity_id == entity_b.entity_id:
		failures.append(
			"multi_entity: universe seeds 0 and 1 both resolved to '%s' — roster growth was not absorbed"
			% entity_a.entity_id
		)

	return failures
