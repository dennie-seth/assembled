extends SceneTree
## T-0103: Audio bus split — four-bus layout and routing tests (D-20).
##
## Verifies:
##   1. All four buses exist: Ambience, Music, World SFX, Gameplay SFX.
##   2. Music ducking attenuates Ambience only — Ambience has an
##      AudioEffectCompressor with sidechain = "Music"; no other bus does.
##   3. Gameplay SFX has NO AudioEffectCompressor (never ducked under any
##      condition — triggering music ducking never attenuates this bus).
##   4. World SFX has at least one AudioEffectCompressor (lightly duckable).
##   5. AudioRouter.route_player() assigns the correct .bus to an
##      AudioStreamPlayer based on the bus_name argument (from T-0082
##      asset metadata).
##   6. AudioRouter.route_player_2d() assigns the correct .bus to an
##      AudioStreamPlayer2D.
##   7. AudioRouter rejects an unknown bus name without crashing.
##
## Run headless:
##   godot --headless --script tests/test_audio_bus_split.gd
## from client/. Exit 0 on PASS, 1 on any failure.

## audio_router.gd loaded by path — avoids the class_name/autoload conflict.
## (Godot 4 disallows class_name that shadows an autoload singleton name.)
const _ROUTER_SCRIPT: GDScript = preload("res://audio_router.gd")

const EXPECTED_BUSES: Array[String] = [
	"Ambience",
	"Music",
	"World SFX",
	"Gameplay SFX",
]

func _init() -> void:
	var failures: Array[String] = []

	# Set up buses via AudioRouter exactly as the autoload does at runtime.
	# This makes the test independent of SceneTree-vs-autoload startup order.
	var router: Node = _ROUTER_SCRIPT.new()
	router.setup_buses()

	# ── 1. All four buses exist ────────────────────────────────────────────
	for bus_name: String in EXPECTED_BUSES:
		if AudioServer.get_bus_index(bus_name) == -1:
			failures.append("bus '%s' not found in AudioServer" % bus_name)

	# ── 2. Music ducking attenuates Ambience only ─────────────────────────
	# Ambience must have a compressor sidechained to "Music".
	var ambience_idx: int = AudioServer.get_bus_index("Ambience")
	if ambience_idx != -1:
		var found_music_sidechain: bool = false
		for i: int in range(AudioServer.get_bus_effect_count(ambience_idx)):
			var effect: AudioEffect = AudioServer.get_bus_effect(ambience_idx, i)
			if effect is AudioEffectCompressor:
				var comp: AudioEffectCompressor = effect as AudioEffectCompressor
				if comp.sidechain == &"Music":
					found_music_sidechain = true
		if not found_music_sidechain:
			failures.append(
				"Ambience bus missing AudioEffectCompressor with sidechain=Music"
			)

	# No bus other than Ambience may have a compressor sidechained to "Music".
	# This proves "music ducking attenuates Ambience only".
	for bus_name: String in ["Music", "World SFX", "Gameplay SFX"]:
		var bus_idx: int = AudioServer.get_bus_index(bus_name)
		if bus_idx == -1:
			continue
		for i: int in range(AudioServer.get_bus_effect_count(bus_idx)):
			var effect: AudioEffect = AudioServer.get_bus_effect(bus_idx, i)
			if effect is AudioEffectCompressor:
				var comp: AudioEffectCompressor = effect as AudioEffectCompressor
				if comp.sidechain == &"Music":
					failures.append(
						"bus '%s' has an AudioEffectCompressor with sidechain=Music — music must only duck Ambience" % bus_name
					)

	# ── 3. Gameplay SFX has NO AudioEffectCompressor (never ducked) ───────
	# This is the structural proof that "triggering music ducking never
	# attenuates the Gameplay SFX bus" — there is no effect on this bus
	# that could respond to any signal.
	var gameplay_sfx_idx: int = AudioServer.get_bus_index("Gameplay SFX")
	if gameplay_sfx_idx != -1:
		for i: int in range(AudioServer.get_bus_effect_count(gameplay_sfx_idx)):
			if AudioServer.get_bus_effect(gameplay_sfx_idx, i) is AudioEffectCompressor:
				failures.append(
					"Gameplay SFX bus has an AudioEffectCompressor at effect index %d — must never be ducked" % i
				)

	# ── 4. World SFX has at least one AudioEffectCompressor (lightly duckable)
	var world_sfx_idx: int = AudioServer.get_bus_index("World SFX")
	if world_sfx_idx != -1:
		var has_compressor: bool = false
		for i: int in range(AudioServer.get_bus_effect_count(world_sfx_idx)):
			if AudioServer.get_bus_effect(world_sfx_idx, i) is AudioEffectCompressor:
				has_compressor = true
		if not has_compressor:
			failures.append(
				"World SFX bus has no AudioEffectCompressor — expected lightly duckable"
			)

	# ── 5. AudioRouter.route_player() routes by metadata bus name ─────────
	var player: AudioStreamPlayer = AudioStreamPlayer.new()
	router.route_player(player, &"Gameplay SFX")
	if player.bus != &"Gameplay SFX":
		failures.append(
			"route_player() with 'Gameplay SFX': bus is '%s', expected 'Gameplay SFX'" % player.bus
		)

	router.route_player(player, &"Ambience")
	if player.bus != &"Ambience":
		failures.append(
			"route_player() with 'Ambience': bus is '%s', expected 'Ambience'" % player.bus
		)

	router.route_player(player, &"Music")
	if player.bus != &"Music":
		failures.append(
			"route_player() with 'Music': bus is '%s', expected 'Music'" % player.bus
		)

	router.route_player(player, &"World SFX")
	if player.bus != &"World SFX":
		failures.append(
			"route_player() with 'World SFX': bus is '%s', expected 'World SFX'" % player.bus
		)

	player.free()

	# ── 6. AudioRouter.route_player_2d() routes by metadata bus name ──────
	var player2d: AudioStreamPlayer2D = AudioStreamPlayer2D.new()
	router.route_player_2d(player2d, &"Gameplay SFX")
	if player2d.bus != &"Gameplay SFX":
		failures.append(
			"route_player_2d() with 'Gameplay SFX': bus is '%s', expected 'Gameplay SFX'" % player2d.bus
		)

	router.route_player_2d(player2d, &"World SFX")
	if player2d.bus != &"World SFX":
		failures.append(
			"route_player_2d() with 'World SFX': bus is '%s', expected 'World SFX'" % player2d.bus
		)

	player2d.free()

	# ── 7. Unknown bus name does not crash ────────────────────────────────
	# route_player() must not crash on an unknown bus; it must push an error
	# and leave the player's bus unchanged.
	var player3: AudioStreamPlayer = AudioStreamPlayer.new()
	var bus_before: StringName = player3.bus
	router.route_player(player3, &"NonExistentBus")
	if player3.bus != bus_before:
		failures.append(
			"route_player() with unknown bus changed player.bus from '%s' to '%s'" % [bus_before, player3.bus]
		)
	player3.free()

	router.free()  # Clean up the router instance created at the top of _init()

	# ── Report ────────────────────────────────────────────────────────────
	if failures.is_empty():
		print("T-0103 PASS: four-bus split, ducking rules, and AudioRouter routing verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0103 FAIL: %s" % f)
		quit(1)
