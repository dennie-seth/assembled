extends SceneTree
## T-0065: NoteCatalog — shared/note_templates.hpp metadata query tests.
##
## Verifies that NoteCatalog exposes template slot arity/category and word
## category/label lookups drawn directly from shared/note_templates.hpp, with
## no hardcoded duplicate of that table anywhere else. This is the data the
## note composer UI uses to build its dropdown option lists and to guarantee
## it can never emit a slot arity/category the server would reject.
##
## Run headless:
##   godot --headless --script tests/test_note_catalog.gd
## from client/. Exit 0 on PASS, 1 on any failure.

## WordCategory values (shared/note_templates.hpp): DIRECTION=1 HAZARD=2
## ACTION=3 OBJECT=4 QUALIFIER=5.
const DIRECTION: int = 1
const HAZARD: int = 2
const ACTION: int = 3
const OBJECT: int = 4
const QUALIFIER: int = 5


func _init() -> void:
	var failures: Array[String] = []

	if not ClassDB.class_exists("NoteCatalog"):
		printerr("T-0065 FAIL: NoteCatalog class not registered — GDExtension did not load")
		quit(1)
		return

	var c: NoteCatalog = NoteCatalog.new()

	failures += _test_template_ids(c)
	failures += _test_template_slot_count(c)
	failures += _test_template_slot_category(c)
	failures += _test_word_ids_for_category(c)
	failures += _test_word_category(c)
	failures += _test_word_label(c)
	failures += _test_template_label(c)

	if failures.is_empty():
		print("T-0065 PASS: NoteCatalog metadata matches shared/note_templates.hpp")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0065 FAIL: %s" % f)
		quit(1)


## ── get_template_ids() ───────────────────────────────────────────────────────
## All 20 shipped template IDs (1..20), no more, no fewer.

func _test_template_ids(c: NoteCatalog) -> Array[String]:
	var failures: Array[String] = []
	var ids: PackedInt32Array = c.get_template_ids()

	if ids.size() != 20:
		failures.append("get_template_ids(): expected 20 entries, got %d" % ids.size())

	var seen: Dictionary = {}
	for id: int in ids:
		seen[id] = true
	for expected: int in range(1, 21):
		if not seen.has(expected):
			failures.append("get_template_ids(): missing template id %d" % expected)

	return failures


## ── get_template_slot_count() ───────────────────────────────────────────────

func _test_template_slot_count(c: NoteCatalog) -> Array[String]:
	var failures: Array[String] = []

	# Two-slot template.
	if c.get_template_slot_count(1) != 2:
		failures.append(
			"get_template_slot_count(1): expected 2, got %d" % c.get_template_slot_count(1)
		)
	# One-slot template.
	if c.get_template_slot_count(5) != 1:
		failures.append(
			"get_template_slot_count(5): expected 1, got %d" % c.get_template_slot_count(5)
		)
	# Zero-slot (item_ref-only) template.
	if c.get_template_slot_count(13) != 0:
		failures.append(
			"get_template_slot_count(13): expected 0, got %d" % c.get_template_slot_count(13)
		)
	# Zero-slot (fixed-phrase) template.
	if c.get_template_slot_count(20) != 0:
		failures.append(
			"get_template_slot_count(20): expected 0, got %d" % c.get_template_slot_count(20)
		)
	# Unknown template.
	if c.get_template_slot_count(999) != -1:
		failures.append(
			"get_template_slot_count(999): expected -1, got %d" % c.get_template_slot_count(999)
		)

	return failures


## ── get_template_slot_category() ────────────────────────────────────────────

func _test_template_slot_category(c: NoteCatalog) -> Array[String]:
	var failures: Array[String] = []

	# Template 2: "{HAZARD} {DIRECTION}" — slot_a=HAZARD, slot_b=DIRECTION.
	if c.get_template_slot_category(2, 0) != HAZARD:
		failures.append(
			"get_template_slot_category(2, 0): expected HAZARD, got %d"
			% c.get_template_slot_category(2, 0)
		)
	if c.get_template_slot_category(2, 1) != DIRECTION:
		failures.append(
			"get_template_slot_category(2, 1): expected DIRECTION, got %d"
			% c.get_template_slot_category(2, 1)
		)

	# Template 5: "{HAZARD}" — single slot; slot_index 1 is unused -> 0.
	if c.get_template_slot_category(5, 0) != HAZARD:
		failures.append(
			"get_template_slot_category(5, 0): expected HAZARD, got %d"
			% c.get_template_slot_category(5, 0)
		)
	if c.get_template_slot_category(5, 1) != 0:
		failures.append(
			"get_template_slot_category(5, 1): expected 0 (unused), got %d"
			% c.get_template_slot_category(5, 1)
		)

	# Template 13: zero slots -> both slot indices are 0 (unused).
	if c.get_template_slot_category(13, 0) != 0:
		failures.append(
			"get_template_slot_category(13, 0): expected 0 (unused), got %d"
			% c.get_template_slot_category(13, 0)
		)

	# Unknown template -> -1 regardless of slot_index.
	if c.get_template_slot_category(999, 0) != -1:
		failures.append(
			"get_template_slot_category(999, 0): expected -1, got %d"
			% c.get_template_slot_category(999, 0)
		)

	return failures


## ── get_word_ids_for_category() ─────────────────────────────────────────────
## Category counts from shared/note_templates.hpp §2: 8/12/12/16/8.

func _test_word_ids_for_category(c: NoteCatalog) -> Array[String]:
	var failures: Array[String] = []

	var expected_counts: Dictionary = {
		DIRECTION: 8,
		HAZARD: 12,
		ACTION: 12,
		OBJECT: 16,
		QUALIFIER: 8,
	}
	for category: int in expected_counts:
		var ids: PackedInt32Array = c.get_word_ids_for_category(category)
		if ids.size() != expected_counts[category]:
			failures.append(
				"get_word_ids_for_category(%d): expected %d ids, got %d"
				% [category, expected_counts[category], ids.size()]
			)

	# Direction ids are exactly 1..8.
	var direction_ids: PackedInt32Array = c.get_word_ids_for_category(DIRECTION)
	var seen: Dictionary = {}
	for id: int in direction_ids:
		seen[id] = true
	for expected: int in range(1, 9):
		if not seen.has(expected):
			failures.append("get_word_ids_for_category(DIRECTION): missing word id %d" % expected)

	# Invalid category -> empty.
	if c.get_word_ids_for_category(99).size() != 0:
		failures.append(
			"get_word_ids_for_category(99): expected empty, got %d entries"
			% c.get_word_ids_for_category(99).size()
		)

	return failures


## ── get_word_category() ─────────────────────────────────────────────────────

func _test_word_category(c: NoteCatalog) -> Array[String]:
	var failures: Array[String] = []

	if c.get_word_category(1) != DIRECTION:
		failures.append("get_word_category(1): expected DIRECTION, got %d" % c.get_word_category(1))
	if c.get_word_category(9) != HAZARD:
		failures.append("get_word_category(9): expected HAZARD, got %d" % c.get_word_category(9))
	if c.get_word_category(21) != ACTION:
		failures.append("get_word_category(21): expected ACTION, got %d" % c.get_word_category(21))
	if c.get_word_category(33) != OBJECT:
		failures.append("get_word_category(33): expected OBJECT, got %d" % c.get_word_category(33))
	if c.get_word_category(56) != QUALIFIER:
		failures.append(
			"get_word_category(56): expected QUALIFIER, got %d" % c.get_word_category(56)
		)
	if c.get_word_category(999) != -1:
		failures.append("get_word_category(999): expected -1, got %d" % c.get_word_category(999))

	return failures


## ── get_word_label() ────────────────────────────────────────────────────────

func _test_word_label(c: NoteCatalog) -> Array[String]:
	var failures: Array[String] = []

	if c.get_word_label(1) != "ahead":
		failures.append("get_word_label(1): expected 'ahead', got '%s'" % c.get_word_label(1))
	if c.get_word_label(9) != "the drop":
		failures.append("get_word_label(9): expected 'the drop', got '%s'" % c.get_word_label(9))
	if c.get_word_label(56) != "quickly":
		failures.append("get_word_label(56): expected 'quickly', got '%s'" % c.get_word_label(56))
	if not c.get_word_label(999).is_empty():
		failures.append(
			"get_word_label(999): expected '' for unknown word id, got '%s'" % c.get_word_label(999)
		)

	return failures


## ── get_template_label() ────────────────────────────────────────────────────
## Reviewer FAIL (2026-09-11): every dropdown item must show readable text
## built from note_localization.h's kTemplatePatterns with each placeholder
## rendered as its slot's category name — never a bare "Template N" id.
## Templates 1-4/17/18 all share the raw pattern "{A} {B}" and 5-7 all share
## "{A}"; only the category substitution makes them distinguishable.

func _test_template_label(c: NoteCatalog) -> Array[String]:
	var failures: Array[String] = []

	var expected: Dictionary = {
		1: "[action] [qualifier]",
		2: "[hazard] [direction]",
		3: "[object] [direction]",
		4: "[action] [direction]",
		5: "[hazard]",
		6: "[action]",
		7: "[direction]",
		8: "[object] here",
		9: "try [action] [qualifier]",
		10: "beware [hazard] [direction]",
		11: "[qualifier], [action]",
		12: "I need help [direction]",
		13: "I need [item]",
		14: "something is wrong",
		15: "[object] opens with [item]",
		16: "go [direction]",
		17: "[action] [object]",
		18: "[object] [qualifier]",
		19: "watch for [hazard]",
		20: "safe passage",
	}
	for tid: int in expected:
		var got: String = c.get_template_label(tid)
		if got != expected[tid]:
			failures.append(
				"get_template_label(%d): expected '%s', got '%s'" % [tid, expected[tid], got]
			)

	if not c.get_template_label(999).is_empty():
		failures.append(
			"get_template_label(999): expected '' for unknown template id, got '%s'"
			% c.get_template_label(999)
		)

	return failures
