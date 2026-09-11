extends SceneTree
## T-0366 (boot-fail fix, extracted from T-0120/#378): the project's actual
## run/main_scene must compile and run its ready logic.
##
## This is a narrow compile smoke test, distinct from #378's own
## test_main_scene_boot.gd (first-run flow, out of scope here — develop has
## no first-run code). It exists because the duplicate class_name bug
## (tests/test_no_duplicate_class_names.gd) only actually breaks the game
## when the losing script copy is one the main scene's dependency graph
## reaches — three prior review rounds dismissed the resulting SCRIPT ERROR
## as unrelated noise because nothing exercised the main scene itself.
##
## Loads whatever scene project.godot's run/main_scene setting points at
## (never hardcodes the path), adds it to the live tree, lets it run a few
## frames, and asserts:
##   1. The scene's PackedScene loads and instantiates.
##   2. Its script actually compiled (get_script() is non-null).
##   3. Its _ready() logic actually ran — the room's player node exists.
##
## Run headless (from client/):
##   godot --headless --script tests/test_main_scene_compiles.gd
## Exit 0 = PASS, exit 1 = FAIL.

var _inst: Node


func _initialize() -> void:
	call_deferred("_run")


func _run() -> void:
	var failures: Array[String] = []

	var main_scene_path: String = ProjectSettings.get_setting("application/run/main_scene", "")
	if main_scene_path.is_empty():
		failures.append("project.godot: run/main_scene is not set")
		_finish(failures)
		return

	var packed: PackedScene = load(main_scene_path) as PackedScene
	if packed == null:
		failures.append("main_scene: %s did not load as a PackedScene" % main_scene_path)
		_finish(failures)
		return

	_inst = packed.instantiate()
	if _inst == null:
		failures.append("main_scene: %s failed to instantiate" % main_scene_path)
		_finish(failures)
		return

	root.add_child(_inst)
	await process_frame
	await process_frame
	await process_frame

	if _inst.get_script() == null:
		failures.append(
			"main_scene: %s root node has no compiled script attached (compile failure?)"
			% main_scene_path
		)

	var player: Node = _inst.get_node_or_null("Player")
	if player == null:
		failures.append(
			"main_scene: %s never built its Player node — _ready() did not run to completion"
			% main_scene_path
		)

	_finish(failures)


func _finish(failures: Array[String]) -> void:
	if _inst != null:
		_inst.queue_free()

	if failures.is_empty():
		print("T-0366 PASS: main scene (run/main_scene) compiled and ready() ran")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0366 FAIL: " + f)
		quit(1)
