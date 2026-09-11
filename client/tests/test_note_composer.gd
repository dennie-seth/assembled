extends SceneTree
## T-0065: NoteComposer — dropdown-only note composition UI tests.
##
## Verifies:
##   - Template selection populates a dropdown with all 20 shipped templates.
##   - Every template dropdown item's text is the catalog's readable template
##     label (NoteCatalog.get_template_label) — never a bare id or "Template
##     N" — and all 20 labels are pairwise distinct (reviewer FAIL 2026-09-11).
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
##   - The template selector and both slot dropdowns lay out in a container
##     with non-zero, non-overlapping rects for a real two-slot template
##     (Codex PR review 2026-09-11 — previously all three sat at (0,0)).
##   - attach_note_client() drives a real GET /v1/vocabulary request/response
##     (docs/design/03-net-protocol.md §5 Progression) through NoteClient,
##     covering a populated list, an empty list, and an error response —
##     never injecting unlocked ids directly for these cases — and an error
##     response surfaces a visible error state instead of silently presenting
##     empty required dropdowns.
##
## Run headless:
##   godot --headless --script tests/test_note_composer.gd
## from client/. Exit 0 on PASS, 1 on any failure.

const NoteComposer := preload("res://note_composer.gd")
## Reused for its MockHttpServer helper (T-0063) rather than duplicating a
## second TCP-backed mock server here.
const NoteClientTests := preload("res://tests/test_note_client.gd")

## Word ids used across tests (see shared/note_templates.hpp):
##   1 = ahead (DIRECTION), 9 = the drop (HAZARD), 21 = wait (ACTION).
const WORD_AHEAD: int = 1
const WORD_THE_DROP: int = 9
const WORD_WAIT: int = 21

## Local port for the vocabulary-flow mock HTTP server. Distinct from
## test_note_client.gd's MOCK_PORT (19994) so the two test files never race
## for the same port if ever run concurrently.
const VOCAB_MOCK_PORT: int = 19992


func _init() -> void:
	var failures: Array[String] = []

	if not ClassDB.class_exists("NoteCatalog"):
		printerr("T-0065 FAIL: NoteCatalog class not registered — GDExtension did not load")
		quit(1)
		return

	failures += _test_template_dropdown_lists_all_templates()
	failures += _test_template_dropdown_labels_are_readable()
	failures += _test_zero_slot_template_needs_no_vocabulary()
	failures += _test_slot_dropdown_filters_to_unlocked_words_in_category()
	failures += _test_locked_slot_blocks_submission()
	failures += _test_unlocking_a_word_makes_it_selectable()
	failures += _test_switching_templates_resets_slots()
	failures += _test_two_slot_template_request()
	failures += _test_no_free_text_surface()
	failures += await _test_two_slot_layout_no_overlap()
	failures += _test_vocabulary_flow()

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


## ── Template dropdown labels are readable, not bare ids ─────────────────────
## Reviewer FAIL (2026-09-11): the dropdown previously read "Template 1" ..
## "Template 20" — meaningless to a player. Every item's text must equal the
## catalog's own template label (NoteCatalog.get_template_label), never a bare
## id or the literal "Template N" string, and all 20 labels must be pairwise
## distinct — several templates share the same raw pattern ("{A} {B}" /
## "{A}") and are only distinguishable once slot categories are substituted in.

func _test_template_dropdown_labels_are_readable() -> Array[String]:
	var failures: Array[String] = []
	var composer: Control = _make_composer()
	var catalog: NoteCatalog = NoteCatalog.new()

	var seen_texts: Dictionary = {}
	for i in composer.template_option.item_count:
		var tid: int = composer.template_option.get_item_id(i)
		var text: String = composer.template_option.get_item_text(i)
		var expected: String = catalog.get_template_label(tid)

		if text != expected:
			failures.append(
				"template_option item %d (id %d): expected catalog label '%s', got '%s'"
				% [i, tid, expected, text]
			)
		if text == str(tid) or text == "Template %d" % tid:
			failures.append(
				"template_option item %d (id %d): text '%s' is a bare id, not a readable label"
				% [i, tid, text]
			)
		if seen_texts.has(text):
			failures.append(
				"template_option: label '%s' is not unique (ids %d and %d)"
				% [text, seen_texts[text], tid]
			)
		seen_texts[text] = tid

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

	for descendant: Node in _all_descendants(composer):
		if descendant is LineEdit or descendant is TextEdit:
			failures.append(
				"composer tree contains a free-text control (%s) — violates no-free-text-UGC"
				% descendant.get_class()
			)

	composer.free()
	return failures


## Every node under `root`, recursively (root itself excluded). Used so the
## no-free-text check covers the composer's full tree, not just its direct
## children — the layout fix (T-0065 fix round) nests the OptionButtons a
## level deeper inside row containers.
func _all_descendants(root: Node) -> Array[Node]:
	var result: Array[Node] = []
	for child: Node in root.get_children():
		result.append(child)
		result += _all_descendants(child)
	return result


## ── Layout: dropdowns never overlap (Codex PR review 2026-09-11) ────────────
## Reproduces the exact bug Codex found in Godot: with no layout container,
## the template selector and both slot dropdowns all sat at rect (0,0) on top
## of each other for a two-slot template. Adds the composer to the live
## SceneTree and lets two real frames pass so the VBoxContainer/HBoxContainer
## rows actually sort their children (Container defers layout via
## queue_sort()) before asserting every control's global rect is non-zero and
## no pair of rects overlaps.

func _test_two_slot_layout_no_overlap() -> Array[String]:
	var failures: Array[String] = []
	var composer: Control = _make_composer()
	get_root().add_child(composer)
	composer.set_unlocked_words([WORD_THE_DROP, WORD_AHEAD])
	composer.select_template(2) # "{HAZARD} {DIRECTION}" — two slots.

	await process_frame
	await process_frame

	var rects: Dictionary = {
		"template": composer.template_option.get_global_rect(),
		"slot_a": composer.slot_a_option.get_global_rect(),
		"slot_b": composer.slot_b_option.get_global_rect(),
	}

	for label: String in rects:
		var rect: Rect2 = rects[label]
		if rect.size.x <= 0.0 or rect.size.y <= 0.0:
			failures.append("layout: %s rect has non-positive size %s" % [label, str(rect)])

	if rects.template.intersects(rects.slot_a):
		failures.append(
			"layout: template and slot_a rects overlap: %s / %s"
			% [str(rects.template), str(rects.slot_a)]
		)
	if rects.template.intersects(rects.slot_b):
		failures.append(
			"layout: template and slot_b rects overlap: %s / %s"
			% [str(rects.template), str(rects.slot_b)]
		)
	if rects.slot_a.intersects(rects.slot_b):
		failures.append(
			"layout: slot_a and slot_b rects overlap: %s / %s" % [str(rects.slot_a), str(rects.slot_b)]
		)

	composer.free()
	return failures


## ── Vocabulary fetch/response flow (Codex PR review 2026-09-11) ─────────────
## Drives composer.attach_note_client() against a real NoteClient talking to a
## mock HTTP server over GET /v1/vocabulary (docs/design/03-net-protocol.md
## §5 Progression: 200 [ word_id ... ]) rather than calling
## set_unlocked_words() directly — that's the path a real server response
## takes, and the path Codex found broken (the composer cleared its unlocked
## set on any failure with no visible error). Covers a populated list, an
## empty list, and an error response in one server session so the error case
## can also verify a previously-unlocked word does not survive a failed
## refresh.

func _test_vocabulary_flow() -> Array[String]:
	var failures: Array[String] = []
	var mock: NoteClientTests.MockHttpServer = NoteClientTests.MockHttpServer.new()
	if not mock.listen(VOCAB_MOCK_PORT):
		failures.append(
			"vocabulary_flow: could not start mock HTTP server on port %d" % VOCAB_MOCK_PORT
		)
		return failures

	failures += _test_vocabulary_fetch_populated(mock)
	failures += _test_vocabulary_fetch_empty(mock)
	failures += _test_vocabulary_fetch_error(mock)

	mock.stop()
	return failures


## Drive `client` (and `mock`) until its vocabulary_fetched signal fires, or
## `wall_limit_ms` elapses. Returns true iff the signal was observed.
func _drive_until_vocabulary_settled(client: NoteClient, mock: NoteClientTests.MockHttpServer,
		wall_limit_ms: float) -> bool:
	var settled: Array[bool] = [false]
	client.vocabulary_fetched.connect(
		func(_req_id: int, _state: int, _http_status: int, _body: String) -> void: settled[0] = true)
	var start_ms: int = Time.get_ticks_msec()
	while float(Time.get_ticks_msec() - start_ms) < wall_limit_ms:
		mock.pump()
		client.tick(0.016)
		if settled[0]:
			return true
		OS.delay_msec(5)
	return false


## Populated response: GET /v1/vocabulary -> 200 [9] unlocks exactly that word
## and leaves the error state hidden.
func _test_vocabulary_fetch_populated(mock: NoteClientTests.MockHttpServer) -> Array[String]:
	var failures: Array[String] = []
	var client: NoteClient = NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % VOCAB_MOCK_PORT)
	client.set_auth_token("tok")
	var composer: Control = _make_composer()

	mock.queue(200, "[%d]" % WORD_THE_DROP)
	composer.attach_note_client(client)
	if not _drive_until_vocabulary_settled(client, mock, 5000.0):
		failures.append("vocabulary_fetch_populated: vocabulary_fetched signal never arrived")
		composer.free()
		client.free()
		return failures

	composer.select_template(5) # "{HAZARD}"
	if composer.slot_a_option.item_count != 1:
		failures.append(
			"vocabulary_fetch_populated: expected 1 slot_a option, got %d"
			% composer.slot_a_option.item_count
		)
	elif composer.slot_a_option.get_item_id(0) != WORD_THE_DROP:
		failures.append(
			"vocabulary_fetch_populated: expected slot_a option id %d, got %d"
			% [WORD_THE_DROP, composer.slot_a_option.get_item_id(0)]
		)
	if composer.vocabulary_error_label.visible:
		failures.append("vocabulary_fetch_populated: error label must stay hidden on success")

	composer.free()
	client.free()
	return failures


## Empty response: GET /v1/vocabulary -> 200 [] is a legitimate "nothing
## unlocked yet" state, not an error — no error label, and a zero-slot
## template stays composable.
func _test_vocabulary_fetch_empty(mock: NoteClientTests.MockHttpServer) -> Array[String]:
	var failures: Array[String] = []
	var client: NoteClient = NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % VOCAB_MOCK_PORT)
	client.set_auth_token("tok")
	var composer: Control = _make_composer()

	mock.queue(200, "[]")
	composer.attach_note_client(client)
	if not _drive_until_vocabulary_settled(client, mock, 5000.0):
		failures.append("vocabulary_fetch_empty: vocabulary_fetched signal never arrived")
		composer.free()
		client.free()
		return failures

	composer.select_template(5) # "{HAZARD}" — nothing unlocked in that category.
	if composer.slot_a_option.item_count != 0:
		failures.append(
			"vocabulary_fetch_empty: expected 0 slot_a options with an empty vocabulary, got %d"
			% composer.slot_a_option.item_count
		)
	if composer.vocabulary_error_label.visible:
		failures.append(
			"vocabulary_fetch_empty: an empty vocabulary is not a fetch error — error label must stay hidden"
		)

	composer.select_template(14) # zero-slot template.
	if not composer.can_submit():
		failures.append(
			"vocabulary_fetch_empty: zero-slot template must stay submittable with empty vocabulary"
		)

	composer.free()
	client.free()
	return failures


## Error response: a failed refresh must surface a visible error state and
## must not let a word unlocked by an earlier successful fetch survive —
## locked vocabulary stays unavailable on every fetch outcome, not just the
## first one.
func _test_vocabulary_fetch_error(mock: NoteClientTests.MockHttpServer) -> Array[String]:
	var failures: Array[String] = []
	var client: NoteClient = NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % VOCAB_MOCK_PORT)
	client.set_auth_token("tok")
	var composer: Control = _make_composer()

	mock.queue(200, "[%d]" % WORD_THE_DROP)
	composer.attach_note_client(client)
	if not _drive_until_vocabulary_settled(client, mock, 5000.0):
		failures.append("vocabulary_fetch_error: initial vocabulary_fetched signal never arrived")
		composer.free()
		client.free()
		return failures

	mock.queue(500, '{"error":0}')
	client.fetch_vocabulary()
	if not _drive_until_vocabulary_settled(client, mock, 5000.0):
		failures.append("vocabulary_fetch_error: refresh vocabulary_fetched signal never arrived")
		composer.free()
		client.free()
		return failures

	if not composer.vocabulary_error_label.visible:
		failures.append(
			"vocabulary_fetch_error: expected a visible error state, dropdowns silently empty instead"
		)

	composer.select_template(5) # "{HAZARD}"
	if composer.slot_a_option.item_count != 0:
		failures.append(
			(
				"vocabulary_fetch_error: word unlocked before the failed refresh must not still "
				+ "be offered, got %d option(s)"
			) % composer.slot_a_option.item_count
		)
	if composer.can_submit():
		failures.append("vocabulary_fetch_error: composer must not be submittable after a failed fetch")

	composer.free()
	client.free()
	return failures
