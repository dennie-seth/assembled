extends SceneTree
## T-0120 (boot-fail fix): no two client scripts may declare the same global
## class_name.
##
## Godot silently lets two .gd files both declare e.g. `class_name Foo`; the
## failure only surfaces later, as a parse error on whichever file the engine
## happens to compile second ("Class \"Foo\" hides a global script class"),
## and only for scripts that are actually reached at runtime. That is exactly
## how PlayerController (client/player_controller.gd and
## client/scripts/player_controller.gd) and WatcherControllerSideon
## (client/scripts/watcher_controller_sideon.gd and
## client/signal_tower/watcher_controller_sideon.gd) broke the game's boot —
## three prior review rounds treated the resulting SCRIPT ERROR as unrelated
## noise because no test ever loaded the main scene. This scan makes a
## recurrence a fast, obvious failure instead of a silent landmine.
##
## Run headless:
##   godot --headless --script tests/test_no_duplicate_class_names.gd
## from client/. Exit 0 on PASS, 1 on any failure.

## Directory names to skip entirely — Godot's own import cache, never source.
const _SKIP_DIRS: Array[String] = [".godot", ".import"]


func _init() -> void:
	var failures: Array[String] = []

	var files: Array[String] = []
	_scan_dir("res://", files)

	# name -> Array[String] (every file path that declares it).
	var declarations: Dictionary = {}
	var name_re := RegEx.new()
	name_re.compile("^class_name\\s+([A-Za-z_][A-Za-z0-9_]*)")

	for path: String in files:
		var f := FileAccess.open(path, FileAccess.READ)
		if f == null:
			failures.append("could not open %s for scanning" % path)
			continue
		var text: String = f.get_as_text()
		for line: String in text.split("\n"):
			var m: RegExMatch = name_re.search(line)
			if m == null:
				continue
			var class_name_found: String = m.get_string(1)
			if not declarations.has(class_name_found):
				declarations[class_name_found] = []
			(declarations[class_name_found] as Array).append(path)

	var duplicate_names: Array = declarations.keys()
	duplicate_names.sort()
	for name: String in duplicate_names:
		var owners: Array = declarations[name]
		if owners.size() > 1:
			failures.append(
				"class_name %s is declared in %d files: %s" % [name, owners.size(), ", ".join(owners)]
			)

	if failures.is_empty():
		print("T-0120 PASS: no duplicate class_name declarations (%d scripts scanned)" % files.size())
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0120 FAIL: " + f)
		quit(1)


## Recursively collect every `.gd` file under @a path into @a out_files.
func _scan_dir(path: String, out_files: Array[String]) -> void:
	var dir := DirAccess.open(path)
	if dir == null:
		return
	dir.list_dir_begin()
	var entry_name: String = dir.get_next()
	while entry_name != "":
		if entry_name == "." or entry_name == "..":
			entry_name = dir.get_next()
			continue
		var full_path: String = path.path_join(entry_name)
		if dir.current_is_dir():
			if not _SKIP_DIRS.has(entry_name):
				_scan_dir(full_path, out_files)
		elif entry_name.ends_with(".gd"):
			out_files.append(full_path)
		entry_name = dir.get_next()
	dir.list_dir_end()
