class_name BleedClockDriver
extends Node
## Wires an item's bleed timer to the bleed-alpha shader ramp (T-0122).
##
## Reads bleed_at (a Unix timestamp in seconds, from item_instance.bleed_at,
## `04-data-model.md` §3) and bleed_duration_secs (the timer's total span),
## then on every _process() tick computes a normalised proximity in [0.0, 1.0]
## and emits it via bleed_proximity_changed. Connect that signal to
## ChromaSprite nodes to drive the bleed-alpha shader ramp without displaying
## any numeric timer or countdown.
##
## Same mechanism serves both bleed-timer scopes from `07-items-economy.md`
## §5 — only bleed_duration_secs differs between them:
##   held             60-90 min  (item in inventory)
##   world / escrow   48-72 h    (item at an anchor)
##
## Proximity semantics:
##   0.0 = timer just started (bleed far away).
##   1.0 = bleed_at reached or past (item overdue to bleed).
##
## Usage:
##   var driver := BleedClockDriver.new()
##   driver.bleed_at            = item.bleed_at        # Unix seconds
##   driver.bleed_duration_secs = held_or_world_duration
##   driver.bleed_proximity_changed.connect(_on_proximity_changed)
##   add_child(driver)
##
##   func _on_proximity_changed(p: float) -> void:
##       for sprite in bleed_sprites:
##           sprite.bleed_proximity = p

## Unix timestamp (float seconds since epoch) when this item instance bleeds.
## Set from the server's authoritative item_instance.bleed_at field.
var bleed_at: float = 0.0

## Total span of this instance's bleed timer in seconds — 60-90 min for a
## held instance, 48-72 h for a world/escrow-anchored one (07-items-economy.md
## §5). Used to normalise the proximity ramp: proximity = 0.0 when the timer
## started, 1.0 at bleed_at. Must be > 0; if <= 0 the item is treated as
## already overdue (proximity = 1.0).
var bleed_duration_secs: float = 1.0

## Emitted every _process() tick with the current bleed proximity.
## Receivers should set ChromaSprite.bleed_proximity to this value.
## The value is always in [0.0, 1.0] — never a raw countdown in seconds.
signal bleed_proximity_changed(proximity: float)


## Pure static function: compute bleed proximity given a clock reading.
##
## @param now           Current Unix time (float seconds since epoch).
## @param bleed_at      Unix timestamp when this item instance bleeds.
## @param duration_secs Total span of the bleed timer in seconds (> 0).
## @return              Normalised proximity in [0.0, 1.0].
##                      0.0 = timer start; 1.0 = at or past bleed_at.
static func compute_proximity(now: float, bleed_at: float, duration_secs: float) -> float:
	if duration_secs <= 0.0:
		return 1.0
	var remaining: float = bleed_at - now
	# remaining / duration_secs is 1.0 at timer start, 0.0 at bleed_at.
	return clampf(1.0 - (remaining / duration_secs), 0.0, 1.0)


## Compute proximity from the real system clock and emit the signal.
## Called automatically by _process(); can also be called with an injected
## "now" timestamp for deterministic testing (_process_tick(fixture_now)).
func _process_tick(now: float) -> void:
	var p: float = compute_proximity(now, bleed_at, bleed_duration_secs)
	bleed_proximity_changed.emit(p)


func _process(_delta: float) -> void:
	_process_tick(Time.get_unix_time_from_system())
