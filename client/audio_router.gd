class_name AudioRouter
extends Node
## T-0103 (D-20): AudioRouter — routes AudioStreamPlayer nodes to the
## correct Godot audio bus based on the bus-assignment metadata produced by
## AudioAgent (T-0082).
##
## Bus names mirror the Bus enum values in
## tools/audio-agent/src/audio_agent/bus.py, which is the single source of
## truth for the bus vocabulary.  Never hardcode a bus name at a call site;
## always pass the string that came from the asset metadata.
##
## Registered as an autoload singleton ("AudioRouter") in project.godot so
## any scene can call AudioRouter.route_player(...) without importing the
## script.

## Canonical bus names — match Bus enum in audio_agent/bus.py (T-0082).
const BUS_AMBIENCE: StringName = &"Ambience"
const BUS_MUSIC: StringName = &"Music"
const BUS_WORLD_SFX: StringName = &"World SFX"
const BUS_GAMEPLAY_SFX: StringName = &"Gameplay SFX"

## Route a non-positional AudioStreamPlayer to the bus named @p bus_name.
## @p bus_name must be one of the four canonical names above, as stored in
## the asset metadata from T-0082.  Logs an error and leaves @p player
## unchanged if the bus does not exist in the project's AudioBusLayout.
func route_player(player: AudioStreamPlayer, bus_name: StringName) -> void:
	if not _validate_bus(bus_name):
		return
	player.bus = bus_name

## Route a positional AudioStreamPlayer2D to the bus named @p bus_name.
## Same semantics as route_player().
func route_player_2d(player: AudioStreamPlayer2D, bus_name: StringName) -> void:
	if not _validate_bus(bus_name):
		return
	player.bus = bus_name

## @return true if @p bus_name resolves to a bus in the AudioServer layout.
func _validate_bus(bus_name: StringName) -> bool:
	if AudioServer.get_bus_index(bus_name) == -1:
		push_error(
			"AudioRouter: bus '%s' not found in AudioServer layout — asset metadata may be stale" % bus_name
		)
		return false
	return true
