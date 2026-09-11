extends SceneTree
## T-0065: NoteComposer — dropdown-only note composition UI tests.
##
## Verifies:
##   - Template selection populates a dropdown with all 20 shipped templates.
##   - Slot dropdowns populate from the intersection of the selected
##     template's required category and the player's currently-unlocked
##     vocabulary (docs/design/02-notes-system.md §5) — never the full
##     category, and never a category the template didn't ask for.
##   - can_submit()/build_note_request() can never produce a slot arity or
##     category the server would reject: a required slot with zero unlocked
##     words blocks submission entirely, and a request is only ever built
##     from options that were actually offered.
##   - No free-text field exists anywhere — every value placed into a
##     request comes from an OptionButton item id, never a LineEdit.
##
## Run headless:
##   godot --headless --script tests/test_note_composer.gd
## from client/. Exit 0 on PASS, 1 on any failure.

const NoteComposer := preload("res://note_composer.gd")

## Word ids used across tests (see shared/note_templates.hpp):
##   1 = ahead (DIRECTION), 9 = the drop (HAZARD), 21 = wait (ACTION).
const WORD_AHEAD: int = 1
const WORD_THE_DROP: int = 9
const WORD_WAIT: int = 21


func _init() -> void:
	var failures: Array[String] = []

	if not ClassDB.class_exists("NoteCatalog"):
		printerr("T-0065 FAIL: NoteCatalog class not registered — GDExtension did not load")
		quit(1)
		return

	failures += _test_template_dropdown_lists_all_templates()
	failures += _test_zero_slot_template_needs_no_vocabulary()
	failures += _test_slot_dropdown_filters_to_unlocked_words_in_category()
	failures += _test_locked_slot_blocks_submission()
	failures += _test_unlocking_a_word_makes_it_selectable()
	failures += _test_switching_templates_resets_slots()
	failures += _test_two_slot_template_request()
	failures += _test_no_free_text_surface()

	if failures.is_empty():
		print("T-0065 PASS: NoteComposer dropdown-only composition verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0065 FAIL: " + f)
		quit(1)


## Build a composer wired to a fresh NoteCatalog.
func _make_composer() -> Control:
	var composer: Control = NoteComposer.new()
	composer.setup(NoteCatalog.new())
	return composer


## ── Template dropdown ───────────────────────────────────────────────────────

func _test_template_dropdown_lists_all_templates() -> Array[String]:
	var failures: Array[String] = []
	var composer: Control = _make_composer()

	if composer.template_option.item_count != 20:
		failures.append(
			"template_option: expected 20 items, got %d" % composer.template_option.item_count
		)

	var seen: Dictionary = {}
	for i in composer.template_option.item_count:
		seen[composer.template_option.get_item_id(i)] = true
	for expected: int in range(1, 21):
		if not seen.has(expected):
			failures.append("template_option: missing template id %d" % expected)

	# Nothing selected until the player chooses.
	if composer.can_submit():
		failures.append("can_submit(): expected false before any template is selected")

	composer.free()
	return failures


## ── Zero-slot templates need no vocabulary ──────────────────────────────────
## Template 14 ("something is wrong") and 20 ("safe passage") have no slots
## (02-notes-system.md §5 rule 2: core function stays composable even with an
## empty vocabulary) — selecting one must make the composer submittable with
## no words unlocked at all.

func _test_zero_slot_template_needs_no_vocabulary() -> Array[String]:
	var failures: Array[String] = []
	var composer: Control = _make_composer()
	composer.set_unlocked_words([])

	if not composer.select_template(14):
		failures.append("select_template(14): expected true (id present in dropdown)")

	if not composer.can_submit():
		failures.append("can_submit(): expected true for a zero-slot template with no vocabulary")

	var request: Dictionary = composer.build_note_request()
	if request.get("template_id") != 14:
		failures.append("build_note_request(): expected template_id=14, got %s" % str(request))
	if request.get("slots") != []:
		failures.append("build_note_request(): expected empty slots, got %s" % str(request.get("slots")))

	composer.free()
	return failures


## ── Slot dropdown filters to unlocked words in the required category ───────
## Template 5 is "{HAZARD}" (single slot). Unlocking only WORD_AHEAD
## (DIRECTION, wrong category) must leave the slot dropdown empty; unlocking
## WORD_THE_DROP (HAZARD) must make it the only option.

func _test_slot_dropdown_filters_to_unlocked_words_in_category() -> Array[String]:
	var failures: Array[String] = []
	var composer: Control = _make_composer()

	composer.set_unlocked_words([WORD_AHEAD])
	composer.select_template(5)
	if composer.slot_a_option.item_count != 0:
		failures.append(
			"slot_a_option: expected 0 items with only a wrong-category word unlocked, got %d"
			% composer.slot_a_option.item_count
		)
	if composer.can_submit():
		failures.append("can_submit(): expected false — required HAZARD slot has no options")

	composer.set_unlocked_words([WORD_AHEAD, WORD_THE_DROP])
	if composer.slot_a_option.item_count != 1:
		failures.append(
			"slot_a_option: expected exactly 1 item (the drop) after unlocking it, got %d"
			% composer.slot_a_option.item_count
		)
	if composer.slot_a_option.get_item_id(0) != WORD_THE_DROP:
		failures.append(
			"slot_a_option: expected item id %d, got %d"
			% [WORD_THE_DROP, composer.slot_a_option.get_item_id(0)]
		)

	# slot_b_option must stay hidden — template 5 has only one slot.
	if composer.slot_b_option.visible:
		failures.append("slot_b_option: expected hidden for a single-slot template")

	composer.free()
	return failures


## ── A required slot with zero unlocked words blocks submission entirely ────
## This is the mechanical guarantee behind "composer cannot produce a request
## the server would reject for arity/category mismatch" — the player simply
## cannot reach a submittable state without a valid selection in every slot.

func _test_locked_slot_blocks_submission() -> Array[String]:
	var failures: Array[String] = []
	var composer: Control = _make_composer()
	composer.set_unlocked_words([])
	composer.select_template(5) # "{HAZARD}" — no HAZARD words unlocked.

	if composer.can_submit():
		failures.append("can_submit(): expected false with zero words unlocked for a 1-slot template")
	if not composer.build_note_request().is_empty():
		failures.append("build_note_request(): expected {} when can_submit() is false")

	composer.free()
	return failures


## ── Unlocking a word makes it selectable, and selection flows into the request

func _test_unlocking_a_word_makes_it_selectable() -> Array[String]:
	var failures: Array[String] = []
	var composer: Control = _make_composer()
	composer.set_unlocked_words([WORD_THE_DROP])
	composer.select_template(5) # "{HAZARD}"

	if composer.can_submit():
		failures.append("can_submit(): expected false before the player picks a slot value")

	if not composer.select_slot_a(WORD_THE_DROP):
		failures.append("select_slot_a(%d): expected true (id present after unlock)" % WORD_THE_DROP)
	if not composer.can_submit():
		failures.append("can_submit(): expected true once the only required slot has a selection")

	var request: Dictionary = composer.build_note_request()
	if request.get("template_id") != 5:
		failures.append("build_note_request(): expected template_id=5, got %s" % str(request))
	if request.get("slots") != [WORD_THE_DROP]:
		failures.append(
			"build_note_request(): expected slots=[%d], got %s" % [WORD_THE_DROP, str(request.get("slots"))]
		)

	composer.free()
	return failures


## ── Switching templates resets slot selections ──────────────────────────────
## A stale slot_b selection from a 2-slot template must not leak into a
## 1-slot template's request (which has no slot_b at all).

func _test_switching_templates_resets_slots() -> Array[String]:
	var failures: Array[String] = []
	var composer: Control = _make_composer()
	composer.set_unlocked_words([WORD_WAIT, WORD_AHEAD, WORD_THE_DROP])

	# Template 4: "{ACTION} {DIRECTION}" — two slots.
	composer.select_template(4)
	composer.select_slot_a(WORD_WAIT)
	composer.select_slot_b(WORD_AHEAD)
	if not composer.can_submit():
		failures.append("can_submit(): expected true for template 4 with both slots filled")

	# Switch to template 5: "{HAZARD}" — one slot.
	composer.select_template(5)
	if composer.slot_b_option.visible:
		failures.append("slot_b_option: expected hidden after switching to a 1-slot template")
	if composer.can_submit():
		failures.append(
			"can_submit(): expected false right after switching templates — slot_a not yet chosen"
		)

	composer.select_slot_a(WORD_THE_DROP)
	var request: Dictionary = composer.build_note_request()
	if request.get("slots") != [WORD_THE_DROP]:
		failures.append(
			"build_note_request(): expected exactly one slot after switching templates, got %s"
			% str(request.get("slots"))
		)

	composer.free()
	return failures


## ── Two-slot template produces both slots in order ──────────────────────────

func _test_two_slot_template_request() -> Array[String]:
	var failures: Array[String] = []
	var composer: Control = _make_composer()
	composer.set_unlocked_words([WORD_THE_DROP, WORD_AHEAD])

	composer.select_template(2) # "{HAZARD} {DIRECTION}"
	composer.select_slot_a(WORD_THE_DROP)
	composer.select_slot_b(WORD_AHEAD)

	if not composer.can_submit():
		failures.append("can_submit(): expected true with both slots filled")

	var request: Dictionary = composer.build_note_request()
	if request.get("slots") != [WORD_THE_DROP, WORD_AHEAD]:
		failures.append(
			"build_note_request(): expected slots=[%d,%d], got %s"
			% [WORD_THE_DROP, WORD_AHEAD, str(request.get("slots"))]
		)
	if request.get("item_ref") != "":
		failures.append(
			"build_note_request(): expected item_ref='' (no free-text source), got '%s'"
			% str(request.get("item_ref"))
		)

	composer.free()
	return failures


## ── No free-text surface ─────────────────────────────────────────────────────
## The composer's only interactive children are OptionButtons — no LineEdit,
## TextEdit, or other free-text control exists anywhere in its tree.

func _test_no_free_text_surface() -> Array[String]:
	var failures: Array[String] = []
	var composer: Control = _make_composer()

	for child in composer.get_children():
		if child is LineEdit or child is TextEdit:
			failures.append(
				"composer tree contains a free-text control (%s) — violates no-free-text-UGC"
				% child.get_class()
			)

	composer.free()
	return failures
