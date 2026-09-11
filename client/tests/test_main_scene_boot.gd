extends SceneTree
## T-0120 (boot-fail fix): the project's actual main scene must boot.
##
## Every prior T-0120 test drives FirstRunSequence/FirstRunController
## directly — none of them ever load the scene a real player launches into.
## That gap is exactly how a duplicate class_name (see
## test_no_duplicate_class_names.gd) shipped past three review rounds: it
## broke res://scripts/blockout_room.gd's compile, which meant _ready() never
## ran, which meant no first-run screen was ever shown to a player — and
## every other test stayed green because none of them exercise this path.
##
## This loads whatever project.godot's run/main_scene points at, adds it to
## the live tree with no saved identity phrase, and asserts:
##   - the main scene's script actually compiled and attached
##   - the first-run controller was constructed
##   - a first-run blocking screen (phrase-reveal or offline-notice — either
##     is fine; this environment has no server to talk to, so it should be
##     the offline notice) was actually instantiated, added to the tree, and
##     visible
##
## Run headless:
##   godot --headless --script tests/test_main_scene_boot.gd
## from client/. Exit 0 on PASS, 1 on any failure.

const IdentityStore := preload("res://identity_store.gd")

## How long to manually pump the main scene's NoteClient (mirrors _drive() in
## test_first_run_sequence.gd) waiting for the identity request to resolve.
## There is no server listening in this environment, so it resolves almost
## immediately — this is a generous ceiling, not an expected wait.
const WALL_LIMIT_MS: float = 5000.0


func _init() -> void:
	var failures: Array[String] = []

	# A clean "no saved identity phrase" start — the production phrase file
	# (and chroma marker) can be left behind by any other test or a prior
	# manual run in this same user:// directory, and this test is specifically
	# about the returning-player gate NOT firing.
	_remove_if_exists(IdentityStore.PHRASE_FILE)
	var chroma_marker := "user://first_run_chroma_shown.marker"
	_remove_if_exists(chroma_marker)

	var main_scene_path: String = ProjectSettings.get_setting("application/run/main_scene", "")
	if main_scene_path.is_empty():
		failures.append("project.godot has no application/run/main_scene configured")
		_finish(failures)
		return

	var packed: PackedScene = load(main_scene_path)
	if packed == null:
		failures.append("could not load main scene resource at %s" % main_scene_path)
		_finish(failures)
		return

	var instance: Node = packed.instantiate()
	if instance == null:
		failures.append("main scene %s failed to instantiate" % main_scene_path)
		_finish(failures)
		return

	if instance.get_script() == null:
		failures.append(
			"main scene root %s has no compiled script attached — its script failed to compile"
			% main_scene_path
		)
		_finish(failures)
		return

	# Enter the real tree — required for get_tree()/is_inside_tree() calls
	# deeper in the first-run presentation layer (BlockingNoticeScreen defeats
	# ui_cancel/window-close via the tree it's actually inside).
	root.add_child(instance)

	if not instance.has_method("get_first_run_controller"):
		failures.append(
			"main scene root has no get_first_run_controller() — cannot verify the first-run controller was constructed"
		)
		_finish(failures)
		return

	var first_run: Node = instance.get_first_run_controller()
	if first_run == null:
		failures.append("first-run controller was not constructed by the main scene's _ready()")
		_finish(failures)
		return

	if not (
		first_run.has_method("get_note_client")
		and first_run.has_method("get_phrase_screen")
		and first_run.has_method("get_offline_screen")
		and first_run.has_method("get_error_screen")
	):
		failures.append("first-run controller is missing the getters this test needs to verify a screen")
		_finish(failures)
		return

	var note_client: NoteClient = first_run.get_note_client()
	if note_client == null:
		failures.append("first-run controller has no NoteClient — cannot drive the identity request")
		_finish(failures)
		return

	var resolved := _drive_until_screen(note_client, first_run, WALL_LIMIT_MS)
	if not resolved:
		failures.append(
			"no first-run blocking screen appeared within %d ms of entering the main scene"
			% int(WALL_LIMIT_MS)
		)
		_finish(failures)
		return

	var screen: Node = _first_screen(first_run)
	if screen == null:
		failures.append("resolved but no screen reference was found — internal test bug")
		_finish(failures)
		return

	if not screen.is_inside_tree():
		failures.append("first-run blocking screen exists but is not inside the scene tree")
	if "visible" in screen and not screen.visible:
		failures.append("first-run blocking screen exists but is not visible")

	_finish(failures)


func _first_screen(first_run: Node) -> Node:
	var phrase: Node = first_run.get_phrase_screen()
	if phrase != null:
		return phrase
	var offline: Node = first_run.get_offline_screen()
	if offline != null:
		return offline
	return first_run.get_error_screen()


## Manually pump note_client (same pattern as _drive() in
## test_first_run_sequence.gd) until a blocking screen shows up or the wall
## clock runs out. Manual pumping — not reliance on the engine's own frame
## loop — matches every other T-0120 test file and keeps this deterministic.
func _drive_until_screen(note_client: NoteClient, first_run: Node, wall_limit_ms: float) -> bool:
	var start_ms: int = Time.get_ticks_msec()
	while float(Time.get_ticks_msec() - start_ms) < wall_limit_ms:
		note_client.tick(0.016)
		if _first_screen(first_run) != null:
			return true
		OS.delay_msec(5)
	return false


func _remove_if_exists(path: String) -> void:
	if FileAccess.file_exists(path):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(path))


func _finish(failures: Array[String]) -> void:
	if failures.is_empty():
		print("T-0120 PASS: main scene boots and shows a first-run blocking screen")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0120 FAIL: " + f)
		quit(1)
