extends Node
## T-0103 (D-20): AudioRouter — sets up the four-bus audio topology and
## routes AudioStreamPlayer nodes to the correct Godot bus based on the
## bus-assignment metadata produced by AudioAgent (T-0082).
##
## Bus names mirror the Bus enum values in
## tools/audio-agent/src/audio_agent/bus.py (single source of truth).
## Never hardcode a bus name at a call site; always pass the string that
## came from the asset metadata.
##
## Registered as an autoload singleton ("AudioRouter") in project.godot.
## In-scene usage: AudioRouter.route_player(player, metadata_bus_name)
## Note: no class_name declaration — Godot 4 disallows class_name that
## shadows an autoload singleton of the same name.

## Canonical bus names — match Bus enum in audio_agent/bus.py (T-0082).
const BUS_AMBIENCE: StringName = &"Ambience"
const BUS_MUSIC: StringName = &"Music"
const BUS_WORLD_SFX: StringName = &"World SFX"
const BUS_GAMEPLAY_SFX: StringName = &"Gameplay SFX"

## Called automatically when this node enters the scene tree (autoload startup).
func _ready() -> void:
	setup_buses()

## Establishes the four-bus topology required by D-20.  Idempotent: removes
## all non-Master buses first, then re-creates them in canonical order.
## Called from _ready() and can also be called explicitly in test setups.
##
## Ducking rules enforced here:
##   Ambience    — AudioEffectCompressor sidechained to "Music".
##                 Music playback attenuates Ambience and nothing else.
##   Music       — no effects; it is the sidechain source, never a target.
##   World SFX   — AudioEffectCompressor (no sidechain, high threshold,
##                 low ratio): lightly duckable, but not by music.
##   Gameplay SFX — no effects whatsoever; never ducked under any condition.
##                 Entity telegraphs route here (fairness requirement, D-20).
func setup_buses() -> void:
	# Remove all buses except Master (index 0) so this call is idempotent.
	while AudioServer.get_bus_count() > 1:
		AudioServer.remove_bus(AudioServer.get_bus_count() - 1)

	# Bus 1 — Music (no effects; source for Ambience sidechain).
	AudioServer.add_bus()
	AudioServer.set_bus_name(1, BUS_MUSIC)
	AudioServer.set_bus_send(1, &"Master")

	# Bus 2 — Ambience (sidechained compressor: ducked by Music).
	AudioServer.add_bus()
	AudioServer.set_bus_name(2, BUS_AMBIENCE)
	AudioServer.set_bus_send(2, &"Master")
	var ambience_comp: AudioEffectCompressor = AudioEffectCompressor.new()
	ambience_comp.threshold = -24.0
	ambience_comp.ratio = 4.0
	ambience_comp.attack_us = 20.0
	ambience_comp.release_ms = 300.0
	ambience_comp.mix = 1.0
	ambience_comp.sidechain = BUS_MUSIC
	AudioServer.add_bus_effect(2, ambience_comp)

	# Bus 3 — World SFX (light compressor, no sidechain: lightly duckable).
	AudioServer.add_bus()
	AudioServer.set_bus_name(3, BUS_WORLD_SFX)
	AudioServer.set_bus_send(3, &"Master")
	var world_sfx_comp: AudioEffectCompressor = AudioEffectCompressor.new()
	world_sfx_comp.threshold = -12.0
	world_sfx_comp.ratio = 1.5
	world_sfx_comp.attack_us = 20.0
	world_sfx_comp.release_ms = 150.0
	world_sfx_comp.mix = 1.0
	AudioServer.add_bus_effect(3, world_sfx_comp)

	# Bus 4 — Gameplay SFX (no effects: never ducked under any condition).
	AudioServer.add_bus()
	AudioServer.set_bus_name(4, BUS_GAMEPLAY_SFX)
	AudioServer.set_bus_send(4, &"Master")

## Route a non-positional AudioStreamPlayer to the bus named @p bus_name.
## @p bus_name must be one of the four canonical names above, as stored in
## the asset metadata from T-0082.  Logs an error and leaves @p player
## unchanged if the bus does not exist in the current AudioServer layout.
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
