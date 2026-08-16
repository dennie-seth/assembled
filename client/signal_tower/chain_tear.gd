## Chain tear logic per docs/design/12-tears.md §3a.
##
## Signal Tower's tear is a chain tear (archetype 1 of the run's sequence) —
## it connects onward to Hospital rather than opening a foreign pocket.
## Chain tears are home-palette throughout: foreignness is reserved for the
## terminal archetype's pocket tear (Long Descent, 20).
##
## Crossing cost: a held Resonance Key (rare-tier per DL-13). Key is
## transferred onward (removed from inventory), not destroyed — sustains
## circulation per DL-13's simulation results. After the first successful
## crossing the tear stays open for the run and requires no further key.

class_name ChainTear

## Declared anchor tag per 12 §3 (one per archetype, fixed).
const ANCHOR_TAG: String = "signal_tower.tear"

## Item ID of the crossing key (rare-tier, drawn from spawn pool — DL-13).
const REQUIRED_KEY: String = "resonance_key"

## True once the first crossing has been made with a valid key.
## Once open, the tear remains open for the duration of the run (12 §3a).
var is_open: bool = false

## Attempt to cross the tear.
##
## inventory: the player's current held items (Array[String] of item IDs).
##            On success, REQUIRED_KEY is removed (transferred onward).
##
## Returns "" on success, or a human-readable rejection reason on failure.
## A rejection is never a silent no-op — the caller must surface it to the
## player so they understand why crossing failed (T-0180 coverage).
func attempt_cross(inventory: Array[String]) -> String:
	if is_open:
		return ""  ## Tear is already open; free crossing
	if not inventory.has(REQUIRED_KEY):
		return "Crossing requires a Resonance Key"
	inventory.erase(REQUIRED_KEY)
	is_open = true
	return ""

## Reset the tear to its initial locked state.
## Used when a session unlock decays — not during a run (10 §3).
func reset() -> void:
	is_open = false
