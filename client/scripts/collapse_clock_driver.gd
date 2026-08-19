class_name CollapseClockDriver
extends Node
## Wires the collapse clock to chroma intensity (T-0197).
##
## Reads collapse_expires_at (a Unix timestamp in seconds) and
## universe_duration_secs (the total lifespan of this universe), then on every
## _process() tick computes a normalised proximity in [0.0, 1.0] and emits it
## via collapse_proximity_changed.  Connect that signal to ChromaSprite nodes
## to drive the chroma palette-swap shader intensity without displaying any
## numeric timer or countdown.
##
## Proximity semantics:
##   0.0 = universe just born (collapse far away).
##   1.0 = collapse_expires_at reached or past (universe overrun/late).
##
## Usage:
##   var driver := CollapseClockDriver.new()
##   driver.collapse_expires_at    = server_response.collapse_expires_at
##   driver.universe_duration_secs = server_response.universe_duration_secs
##   driver.collapse_proximity_changed.connect(_on_proximity_changed)
##   add_child(driver)
##
##   func _on_proximity_changed(p: float) -> void:
##       for sprite in chroma_sprites:
##           sprite.collapse_proximity = p

## Unix timestamp (float seconds since epoch) when the universe collapses.
## Set from the server's authoritative collapse_expires_at field.
var collapse_expires_at: float = 0.0

## Total lifespan of the universe in seconds (collapse_expires_at - born_at).
## Used to normalise the proximity ramp: proximity = 0.0 at birth, 1.0 at
## collapse_expires_at.  Must be > 0; if <= 0 the universe is treated as
## fully overrun (proximity = 1.0).
var universe_duration_secs: float = 1.0

## Emitted every _process() tick with the current collapse proximity.
## Receivers should set ChromaSprite.collapse_proximity to this value.
## The value is always in [0.0, 1.0] — never a raw countdown in seconds.
signal collapse_proximity_changed(proximity: float)


## Pure static function: compute collapse proximity given a clock reading.
##
## @param now          Current Unix time (float seconds since epoch).
## @param expires_at   Unix timestamp when the universe collapses.
## @param duration_secs Total lifespan of the universe in seconds (> 0).
## @return             Normalised proximity in [0.0, 1.0].
##                     0.0 = birth; 1.0 = at or past collapse.
static func compute_proximity(
		now: float, expires_at: float, duration_secs: float) -> float:
	if duration_secs <= 0.0:
		return 1.0
	var remaining: float = expires_at - now
	# remaining / duration_secs is 1.0 at birth, 0.0 at collapse.
	return clampf(1.0 - (remaining / duration_secs), 0.0, 1.0)


## Compute proximity from the real system clock and emit the signal.
## Called automatically by _process(); can also be called with an injected
## "now" timestamp for deterministic testing (_process_tick(fixture_now)).
func _process_tick(now: float) -> void:
	var p: float = compute_proximity(now, collapse_expires_at, universe_duration_secs)
	collapse_proximity_changed.emit(p)


func _process(_delta: float) -> void:
	_process_tick(Time.get_unix_time_from_system())
