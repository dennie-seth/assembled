## NoteComposer — dropdown-only note composition UI (T-0065).
##
## Builds a template dropdown and up to two slot dropdowns from
## shared/note_templates.hpp (via NoteCatalog) and the player's currently
## unlocked vocabulary (docs/design/02-notes-system.md §5). No LineEdit or
## other free-text control exists anywhere in this tree — every value that
## can end up in a request is an OptionButton item id drawn from the shared
## template/word tables, so the composer cannot produce a slot arity or
## category the server would reject.
##
## Usage:
##   var composer := NoteComposer.new()
##   composer.setup(NoteCatalog.new())
##   composer.attach_note_client(note_client)   # populates unlocked vocabulary
##   composer.select_template(template_id)
##   composer.select_slot_a(word_id)
##   composer.select_slot_b(word_id)
##   if composer.can_submit():
##       var req: Dictionary = composer.build_note_request()
##       note_client.post_note(archetype_id, anchor_tag, req.template_id, req.slots, req.item_ref)
extends Control

## Emitted whenever a template or slot selection changes.  Lets a "Post"
## button enable/disable itself declaratively instead of polling can_submit().
signal composability_changed(can_submit: bool)

var _catalog: NoteCatalog
## Set-like membership map of currently-unlocked word ids (word_id -> true).
var _unlocked_words: Dictionary = {}

var template_option: OptionButton
var slot_a_option: OptionButton
var slot_b_option: OptionButton

## Shown when the vocabulary fetch fails (timeout/4xx/5xx/network error, or a
## malformed body) so an empty required slot dropdown is never mistaken for
## "no words unlocked yet" — see can_submit() docs and _on_vocabulary_fetched.
var vocabulary_error_label: Label


## Wire the catalog and build the dropdown controls. Must be called once
## before any other method.
## @param catalog  NoteCatalog instance (metadata over shared/note_templates.hpp).
func setup(catalog: NoteCatalog) -> void:
	_catalog = catalog
	_build_options()


## Connect to a NoteClient and fetch the player's unlocked vocabulary.
## @param client  Configured NoteClient node.
func attach_note_client(client: NoteClient) -> void:
	client.vocabulary_fetched.connect(_on_vocabulary_fetched)
	client.fetch_vocabulary()


## Replace the set of unlocked word ids and refresh the slot dropdowns.
## @param word_ids  Word ids the player may currently compose with.
func set_unlocked_words(word_ids: Array) -> void:
	_unlocked_words.clear()
	for wid in word_ids:
		_unlocked_words[int(wid)] = true
	_refresh_slots()


## Select a template by id.
## @return true if template_id is present in the dropdown and was selected.
func select_template(template_id: int) -> bool:
	var idx: int = _find_item_index(template_option, template_id)
	if idx < 0:
		return false
	template_option.select(idx)
	_refresh_slots()
	return true


## Select slot_a's value by word id.
## @return true if word_id is a currently-offered option and was selected.
func select_slot_a(word_id: int) -> bool:
	return _select_slot(slot_a_option, word_id)


## Select slot_b's value by word id.
## @return true if word_id is a currently-offered option and was selected.
func select_slot_b(word_id: int) -> bool:
	return _select_slot(slot_b_option, word_id)


## @return the selected template id, or -1 if none is selected.
func get_selected_template_id() -> int:
	if template_option.selected < 0:
		return -1
	return template_option.get_item_id(template_option.selected)


## @return the selected slot_a word id, or -1 if none is selected/applicable.
func get_selected_slot_a_word_id() -> int:
	return _selected_slot_value(slot_a_option)


## @return the selected slot_b word id, or -1 if none is selected/applicable.
func get_selected_slot_b_word_id() -> int:
	return _selected_slot_value(slot_b_option)


## True iff a template is selected and every slot it requires has a selected
## value. Since every offered slot option is already category-correct and
## unlocked, and slots is exactly the template's own arity, a true result
## guarantees build_note_request() cannot be rejected by the server for
## arity or category mismatch.
func can_submit() -> bool:
	var tid: int = get_selected_template_id()
	if tid < 0:
		return false
	var slot_count: int = _catalog.get_template_slot_count(tid)
	if slot_count < 0:
		return false
	if slot_count >= 1 and _selected_slot_value(slot_a_option) < 0:
		return false
	if slot_count >= 2 and _selected_slot_value(slot_b_option) < 0:
		return false
	return true


## Build the {template_id, slots, item_ref} payload for NoteClient.post_note().
## item_ref is always "" — no item-type catalog is exposed to the composer
## yet, and the server does not validate item_ref format (only slot arity and
## category), so this never causes a rejection.
## @return the request Dictionary, or {} if can_submit() is false.
func build_note_request() -> Dictionary:
	if not can_submit():
		return {}
	var tid: int = get_selected_template_id()
	var slot_count: int = _catalog.get_template_slot_count(tid)
	var slots: Array = []
	if slot_count >= 1:
		slots.append(_selected_slot_value(slot_a_option))
	if slot_count >= 2:
		slots.append(_selected_slot_value(slot_b_option))
	return {"template_id": tid, "slots": slots, "item_ref": ""}


## Build the dropdown rows inside a VBoxContainer so the template selector and
## both slot dropdowns each get their own laid-out rect instead of stacking as
## bare Control children at (0,0) on top of each other (T-0065 fix round,
## Codex PR review 2026-09-11). Each row pairs a Label caption with its
## OptionButton so the control is readable on its own, not just by dropdown
## item text.
func _build_options() -> void:
	var layout := VBoxContainer.new()
	layout.name = "Layout"
	add_child(layout)

	template_option = _add_row(layout, "TemplateRow", "Template", "TemplateOption")
	for tid: int in _catalog.get_template_ids():
		template_option.add_item(_catalog.get_template_label(tid), tid)
	# OptionButton auto-selects the first item added to an empty list; force
	# "nothing chosen yet" so can_submit() is false until the player picks.
	template_option.select(-1)
	template_option.item_selected.connect(_on_template_selected)

	slot_a_option = _add_row(layout, "SlotARow", "Slot A", "SlotAOption")
	slot_a_option.get_parent().visible = false
	slot_a_option.visible = false
	slot_a_option.item_selected.connect(_on_slot_selected)

	slot_b_option = _add_row(layout, "SlotBRow", "Slot B", "SlotBOption")
	slot_b_option.get_parent().visible = false
	slot_b_option.visible = false
	slot_b_option.item_selected.connect(_on_slot_selected)

	vocabulary_error_label = Label.new()
	vocabulary_error_label.name = "VocabularyErrorLabel"
	vocabulary_error_label.text = "Vocabulary unavailable — try again"
	vocabulary_error_label.visible = false
	layout.add_child(vocabulary_error_label)


## Add an HBoxContainer row of {caption Label, OptionButton} to `parent`.
## @return the row's OptionButton.
func _add_row(parent: Control, row_name: String, label_text: String, option_name: String) -> OptionButton:
	var row := HBoxContainer.new()
	row.name = row_name
	parent.add_child(row)

	var label := Label.new()
	label.name = option_name + "Label"
	label.text = label_text
	row.add_child(label)

	var option := OptionButton.new()
	option.name = option_name
	row.add_child(option)
	return option


func _on_template_selected(_index: int) -> void:
	_refresh_slots()


func _on_slot_selected(_index: int) -> void:
	composability_changed.emit(can_submit())


## Handle NoteClient's vocabulary_fetched signal (docs/design/03-net-protocol.md
## §5 Progression: GET /v1/vocabulary -> 200 [ word_id ... ]). Any non-OK
## state or a body that isn't the documented JSON array of word ids is a
## fetch failure: it surfaces a visible error rather than silently leaving
## required dropdowns empty, and it never falls back to the full word
## catalogue — locked vocabulary must stay unavailable either way.
func _on_vocabulary_fetched(
		_req_id: int, state: int, _http_status: int, body: String) -> void:
	if state != NoteClient.STATE_OK:
		_show_vocabulary_error()
		return
	var json := JSON.new()
	if json.parse(body) != OK:
		_show_vocabulary_error()
		return
	var data: Variant = json.get_data()
	if not data is Array:
		_show_vocabulary_error()
		return
	vocabulary_error_label.visible = false
	set_unlocked_words(data)


func _show_vocabulary_error() -> void:
	vocabulary_error_label.visible = true
	set_unlocked_words([])


func _refresh_slots() -> void:
	var tid: int = get_selected_template_id()
	_populate_slot(slot_a_option, tid, 0)
	_populate_slot(slot_b_option, tid, 1)
	composability_changed.emit(can_submit())


## Repopulate one slot's dropdown with the intersection of the template's
## required category (from NoteCatalog) and the currently-unlocked word set —
## the mechanism behind "populated by their currently-unlocked vocabulary
## tier" (T-0065 acceptance).
func _populate_slot(option: OptionButton, template_id: int, slot_index: int) -> void:
	option.clear()
	var row: Control = option.get_parent()
	if template_id < 0:
		option.visible = false
		if row:
			row.visible = false
		return
	var slot_count: int = _catalog.get_template_slot_count(template_id)
	if slot_index >= slot_count:
		option.visible = false
		if row:
			row.visible = false
		return
	option.visible = true
	if row:
		row.visible = true
	var category: int = _catalog.get_template_slot_category(template_id, slot_index)
	var candidates: PackedInt32Array = _catalog.get_word_ids_for_category(category)
	for wid: int in candidates:
		if _unlocked_words.has(wid):
			option.add_item(_catalog.get_word_label(wid), wid)
	# OptionButton auto-selects the first item added to an empty list; force
	# "nothing chosen yet" so can_submit() is false until the player picks.
	option.select(-1)


func _select_slot(option: OptionButton, word_id: int) -> bool:
	var idx: int = _find_item_index(option, word_id)
	if idx < 0:
		return false
	option.select(idx)
	composability_changed.emit(can_submit())
	return true


func _find_item_index(option: OptionButton, id: int) -> int:
	for i in option.item_count:
		if option.get_item_id(i) == id:
			return i
	return -1


func _selected_slot_value(option: OptionButton) -> int:
	if not option.visible or option.item_count == 0 or option.selected < 0:
		return -1
	return option.get_item_id(option.selected)
