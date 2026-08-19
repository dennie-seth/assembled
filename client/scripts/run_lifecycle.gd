## RunLifecycle — client-side run state machine (T-0196).
##
## Manages the three-scope nesting from 01-vision.md §6:
##   identity -> universe -> run -> room
##
## A run:
##   - Is started with exactly 3 archetype/variant pairs (server-authoritative
##     via POST /v1/runs; local fallback when offline — 03-net-protocol.md §6).
##   - Ends via death, quit, or unrecovered disconnect (lease expiry).
##   - Scatters all held items visibly into the network on end.
##   - Can be restarted with the same archetypes (try_again) or a fresh
##     server-assembled selection (new_game) — 01-vision.md §6 "After a Run Ends".
##
## HTTP transport (POST /v1/runs, POST /v1/runs/{id}/end) is owned by the caller.
## This class owns only the state machine and its signals.
##
## Usage:
##   var rl := RunLifecycle.new()
##   rl.run_started.connect(_on_run_started)
##   rl.item_scattered.connect(_on_item_scattered)
##   rl.scatter_complete.connect(_on_scatter_complete)
##   rl.restart_ready.connect(_on_restart_ready)
##   rl.set_held_items(["item-uuid-1", "item-uuid-2"])
##   rl.start_run("run-uuid", [{archetype_id=1,variant_id=1}, ...])
##   # ... player traverses rooms ...
##   rl.end_run(RunLifecycle.EndCause.DEATH)
##   # item_scattered fires once per held item; then scatter_complete fires.
##   rl.try_again()   # or rl.new_game()
extends RefCounted

## Three states the run can be in.
enum RunState {
	IDLE,    ## No active run — between runs or before the first.
	RUNNING, ## A run is in progress.
	ENDED,   ## Run has ended and held items have scattered.
}

## The three ways a run can end (01-vision.md §6).
enum EndCause {
	DEATH,      ## Killed by a trap or foreign entity.
	QUIT,       ## Player voluntarily ended the run.
	DISCONNECT, ## Unrecovered session lease expiry (09-identity.md §3).
}

## Emitted when a run transitions to RUNNING.
## @param archetypes  Array of Dictionaries [{archetype_id: int, variant_id: int}, ...].
signal run_started(archetypes: Array)

## Emitted once per held item while run is transitioning to ENDED.
## Drives the visible item-scatter animation.
## @param item_id  UUID of the scattered item instance.
signal item_scattered(item_id: String)

## Emitted after all held items have scattered.
## @param cause  An EndCause value identifying how the run ended.
signal scatter_complete(cause: int)

## Emitted when a restart choice is finalised.
## @param archetypes  Pinned set from the just-ended run (try_again),
##                    or empty array (new_game — server re-assembles fresh).
signal restart_ready(archetypes: Array)

var _state: RunState = RunState.IDLE
var _run_id: String = ""
var _archetypes: Array = []
var _held_items: Array[String] = []


## Current state of the run state machine.
func get_state() -> RunState:
	return _state


## Server-assigned UUID for the active (or most-recently-ended) run.
func get_run_id() -> String:
	return _run_id


## Archetype/variant selection for the active or most-recently-ended run.
## Returns a copy; mutations by the caller do not affect internal state.
func get_archetypes() -> Array:
	return _archetypes.duplicate()


## Begin a run with the server-assembled archetype set.
## No-op (with a push_error) if the state machine is not IDLE.
## @param run_id     Server-assigned run UUID (from POST /v1/runs).
## @param archetypes Array of 3 {archetype_id, variant_id} Dictionaries.
func start_run(run_id: String, archetypes: Array) -> void:
	if _state != RunState.IDLE:
		push_error(
			"RunLifecycle.start_run: called in state %d (expected IDLE) — ignoring" % _state
		)
		return
	_run_id = run_id
	_archetypes = archetypes.duplicate()
	_held_items.clear()
	_state = RunState.RUNNING
	run_started.emit(_archetypes)


## Register the items the player is currently holding.
## Call before end_run() so the correct items scatter.
## @param items  Array of item instance UUIDs.
func set_held_items(items: Array[String]) -> void:
	_held_items = items.duplicate()


## End the run with the given cause, visibly scattering all held items.
## No-op if the state machine is not RUNNING (prevents double-scatter on
## repeated calls or stale signals).
## @param cause  An EndCause value.
func end_run(cause: int) -> void:
	if _state != RunState.RUNNING:
		return
	_state = RunState.ENDED
	for item_id: String in _held_items:
		item_scattered.emit(item_id)
	_held_items.clear()
	scatter_complete.emit(cause)


## Restart with the same archetype/variant selection as the run that just ended.
## State returns to IDLE; emits restart_ready with the pinned archetype array.
## Returns the pinned array for convenience.
## No-op (returns []) if state is not ENDED.
## 01-vision.md §6: "Try Again re-assembles the same archetype/variant selection."
func try_again() -> Array:
	if _state != RunState.ENDED:
		return []
	var pinned: Array = _archetypes.duplicate()
	_state = RunState.IDLE
	restart_ready.emit(pinned)
	return pinned


## Clear archetype selection and prepare for a fresh server-assembled run.
## State returns to IDLE; emits restart_ready with an empty array.
## No-op if state is not ENDED.
## 01-vision.md §6: "New Game assembles a fresh selection under normal rules."
func new_game() -> void:
	if _state != RunState.ENDED:
		return
	_archetypes.clear()
	_run_id = ""
	_state = RunState.IDLE
	restart_ready.emit([])
