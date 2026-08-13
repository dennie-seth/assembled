extends SceneTree
## T-0064: NoteRenderer — template rendering from shared/ table.
##
## Verifies that NoteRenderer correctly renders all 20 shipped templates using
## shared/note_templates.hpp word and template IDs as the single source of truth,
## and that a missing localization key (unknown ID) fails loudly rather than
## producing a blank or garbled render.
##
## Run headless:
##   godot --headless --script tests/test_note_renderer.gd
## from client/. Exit 0 on PASS, 1 on any failure.

func _init() -> void:
	var failures: Array[String] = []

	if not ClassDB.class_exists("NoteRenderer"):
		printerr("T-0064 FAIL: NoteRenderer class not registered — GDExtension did not load")
		quit(1)
		return

	var r: NoteRenderer = NoteRenderer.new()

	# ── Localization coverage ─────────────────────────────────────────────────
	# All shipped word IDs (1–56) and template IDs (1–20) must have localization
	# entries; has_complete_localization() returns false if any are missing.
	if not r.has_complete_localization():
		failures.append("has_complete_localization() returned false — at least one shipped ID has no localization string")

	# ── Fixed-phrase templates (no slots) ─────────────────────────────────────
	# Template 14: "something is wrong"
	var t14: String = r.render(14, 0, 0, "")
	if t14 != "something is wrong":
		failures.append("template 14: expected 'something is wrong', got '%s'" % t14)

	# Template 20: "safe passage"
	var t20: String = r.render(20, 0, 0, "")
	if t20 != "safe passage":
		failures.append("template 20: expected 'safe passage', got '%s'" % t20)

	# ── Single-slot templates ─────────────────────────────────────────────────
	# Template 7: {DIRECTION}  — word 1 = "ahead"
	var t7: String = r.render(7, 1, 0, "")
	if t7 != "ahead":
		failures.append("template 7 (word 1): expected 'ahead', got '%s'" % t7)

	# Template 6: {ACTION}  — word 22 = "run"
	var t6: String = r.render(6, 22, 0, "")
	if t6 != "run":
		failures.append("template 6 (word 22): expected 'run', got '%s'" % t6)

	# Template 5: {HAZARD}  — word 9 = "the drop"
	var t5: String = r.render(5, 9, 0, "")
	if t5 != "the drop":
		failures.append("template 5 (word 9): expected 'the drop', got '%s'" % t5)

	# Template 8: {OBJECT} here  — word 33 = "the door"
	var t8: String = r.render(8, 33, 0, "")
	if t8 != "the door here":
		failures.append("template 8 (word 33): expected 'the door here', got '%s'" % t8)

	# Template 12: I need help {DIRECTION}  — word 6 = "right"
	var t12: String = r.render(12, 6, 0, "")
	if t12 != "I need help right":
		failures.append("template 12 (word 6): expected 'I need help right', got '%s'" % t12)

	# Template 16: go {DIRECTION}  — word 2 = "behind"
	var t16: String = r.render(16, 2, 0, "")
	if t16 != "go behind":
		failures.append("template 16 (word 2): expected 'go behind', got '%s'" % t16)

	# Template 19: watch for {HAZARD}  — word 19 = "the beast"
	var t19: String = r.render(19, 19, 0, "")
	if t19 != "watch for the beast":
		failures.append("template 19 (word 19): expected 'watch for the beast', got '%s'" % t19)

	# ── Two-slot templates ────────────────────────────────────────────────────
	# Template 1: {ACTION} {QUALIFIER}  — word 21 "wait" + word 49 "slowly"
	var t1: String = r.render(1, 21, 49, "")
	if t1 != "wait slowly":
		failures.append("template 1: expected 'wait slowly', got '%s'" % t1)

	# Template 2: {HAZARD} {DIRECTION}  — word 9 "the drop" + word 1 "ahead"
	var t2: String = r.render(2, 9, 1, "")
	if t2 != "the drop ahead":
		failures.append("template 2: expected 'the drop ahead', got '%s'" % t2)

	# Template 3: {OBJECT} {DIRECTION}  — word 33 "the door" + word 5 "left"
	var t3: String = r.render(3, 33, 5, "")
	if t3 != "the door left":
		failures.append("template 3: expected 'the door left', got '%s'" % t3)

	# Template 4: {ACTION} {DIRECTION}  — word 22 "run" + word 8 "beyond"
	var t4: String = r.render(4, 22, 8, "")
	if t4 != "run beyond":
		failures.append("template 4: expected 'run beyond', got '%s'" % t4)

	# Template 9: try {ACTION} {QUALIFIER}  — word 23 "hide" + word 54 "carefully"
	var t9: String = r.render(9, 23, 54, "")
	if t9 != "try hide carefully":
		failures.append("template 9: expected 'try hide carefully', got '%s'" % t9)

	# Template 10: beware {HAZARD} {DIRECTION}  — word 14 "the dark" + word 3 "below"
	var t10: String = r.render(10, 14, 3, "")
	if t10 != "beware the dark below":
		failures.append("template 10: expected 'beware the dark below', got '%s'" % t10)

	# Template 11: {QUALIFIER}, {ACTION}  — slot_a=QUALIFIER word 52 "only once", slot_b=ACTION word 29 "stop"
	var t11: String = r.render(11, 52, 29, "")
	if t11 != "only once, stop":
		failures.append("template 11: expected 'only once, stop', got '%s'" % t11)

	# Template 17: {ACTION} {OBJECT}  — word 31 "climb" + word 40 "the passage"
	var t17: String = r.render(17, 31, 40, "")
	if t17 != "climb the passage":
		failures.append("template 17: expected 'climb the passage', got '%s'" % t17)

	# Template 18: {OBJECT} {QUALIFIER}  — word 48 "the hatch" + word 55 "quietly"
	var t18: String = r.render(18, 48, 55, "")
	if t18 != "the hatch quietly":
		failures.append("template 18: expected 'the hatch quietly', got '%s'" % t18)

	# ── item_ref templates ────────────────────────────────────────────────────
	# Template 13: I need {item_ref}  — no slots, item_ref only
	var t13: String = r.render(13, 0, 0, "bandage")
	if t13 != "I need bandage":
		failures.append("template 13: expected 'I need bandage', got '%s'" % t13)

	# Template 15: {OBJECT} opens with {item_ref}  — word 41 "the key", item_ref "locker code"
	var t15: String = r.render(15, 41, 0, "locker code")
	if t15 != "the key opens with locker code":
		failures.append("template 15: expected 'the key opens with locker code', got '%s'" % t15)

	# ── All 20 templates produce non-empty output with valid representative IDs ─
	# Use word 1 (DIRECTION), 9 (HAZARD), 21 (ACTION), 33 (OBJECT), 49 (QUALIFIER).
	# item_ref = "item" for templates that need it.
	var representative_slots: Dictionary = {
		1: [21, 49],   # ACTION QUALIFIER
		2: [9, 1],     # HAZARD DIRECTION
		3: [33, 1],    # OBJECT DIRECTION
		4: [21, 1],    # ACTION DIRECTION
		5: [9, 0],     # HAZARD
		6: [21, 0],    # ACTION
		7: [1, 0],     # DIRECTION
		8: [33, 0],    # OBJECT
		9: [21, 49],   # ACTION QUALIFIER
		10: [9, 1],    # HAZARD DIRECTION
		11: [49, 21],  # QUALIFIER ACTION
		12: [1, 0],    # DIRECTION
		13: [0, 0],    # item_ref
		14: [0, 0],    # fixed
		15: [33, 0],   # OBJECT item_ref
		16: [1, 0],    # DIRECTION
		17: [21, 33],  # ACTION OBJECT
		18: [33, 49],  # OBJECT QUALIFIER
		19: [9, 0],    # HAZARD
		20: [0, 0],    # fixed
	}
	for tid: int in representative_slots:
		var slots: Array = representative_slots[tid]
		var result: String = r.render(tid, slots[0], slots[1], "item")
		if result.is_empty():
			failures.append("template %d: render() returned empty string with valid IDs" % tid)

	# ── Missing localization key: unknown template ID ──────────────────────────
	# The renderer must return "" (fail loudly via ERR_FAIL_V_MSG to stderr)
	# rather than returning a garbled/blank string silently.
	var unknown_tmpl: String = r.render(999, 1, 0, "")
	if not unknown_tmpl.is_empty():
		failures.append("render(999,...) should return '' for unknown template ID, got '%s'" % unknown_tmpl)

	# ── Missing localization key: unknown word ID ─────────────────────────────
	var unknown_word: String = r.render(7, 999, 0, "")
	if not unknown_word.is_empty():
		failures.append("render(7,999,...) should return '' for unknown word ID, got '%s'" % unknown_word)

	# ── Report ────────────────────────────────────────────────────────────────
	if failures.is_empty():
		print("T-0064 PASS: NoteRenderer renders all 20 templates correctly; missing-key guard works")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0064 FAIL: %s" % f)
		quit(1)
