## TearNode — crossing state machine for chain and pocket tears (T-0180).
##
## A tear is a declared anchor tag, structurally identical to a note/item anchor
## (12-tears.md §1). Two types exist per run:
##   CHAIN  (archetypes 1-2): unique-keyed first-cross; tear stays open thereafter.
##   POCKET (archetype 3):    free to cross; foreign-palette content; stable pool.
##
## Bind a TearNode to its anchor tag (archetype_id, tear_tag) via the same
## anchor-runtime lookup as any other anchor — no new placement system needed.
##
## Usage:
##   var tear := TearNode.new(1, "broadcast_deck", TearNode.TearType.CHAIN, "clearance_chit")
##   var result := tear.cross(player_inventory)
##   match result:
##       TearNode.CROSS_OK:              # proceed to next room
##       TearNode.CROSS_REJECTED_NO_KEY: # surface rejection to player
extends RefCounted

## Crossing succeeded — player may proceed through the tear.
const CROSS_OK: int = 0
## Chain tear crossing rejected: player does not hold the required unique item.
const CROSS_REJECTED_NO_KEY: int = 1

## Tear variant.
##
## CHAIN  — connects archetypes in the run's sequence (archetypes 1-2).
##          Unique-keyed on first crossing; tear stays open for the rest of
##          the run — does not re-lock per crossing (12-tears.md §3a).
## POCKET — terminal archetype's free foreign-reward room (archetype 3).
##          No item cost; content pool seeded on first crossing and stable
##          thereafter — re-crossing never re-rolls or duplicates (INV-6,
##          12-tears.md §3 Reward accounting).
enum TearType { CHAIN = 0, POCKET = 1 }

## The archetype this tear belongs to (1-3 in a 3-archetype run).
var archetype_id: int
## Declared anchor tag identifying this tear within its archetype.
var tear_tag: String
## Whether this is a CHAIN or POCKET tear.
var tear_type: TearType
## (CHAIN only) Name of the unique item that must be held to cross on first use.
var _required_unique: String
## (CHAIN only) True once the tear has been crossed for the first time.
var _is_open: bool = false
## (POCKET only) Spawn pool, locked in on first crossing and stable thereafter.
var _pocket_pool: Array = []

## Construct a TearNode bound to an anchor tag.
## @param a_id       Archetype id (1-3).
## @param tag        Declared anchor tag string.
## @param t_type     TearType.CHAIN or TearType.POCKET.
## @param req_unique (CHAIN only) Required unique item name; pass "" for POCKET.
func _init(a_id: int, tag: String, t_type: TearType, req_unique: String = "") -> void:
	archetype_id = a_id
	tear_tag = tag
	tear_type = t_type
	_required_unique = req_unique

## Attempt to cross this tear.
##
## For a CHAIN tear (12-tears.md §3a):
##   - If already open (previously crossed), returns CROSS_OK immediately —
##     the tear does not re-lock per crossing.
##   - Otherwise checks @a inventory for the required unique. If absent,
##     returns CROSS_REJECTED_NO_KEY without modifying @a inventory.
##   - If present, erases the unique from @a inventory (same semantics as an
##     item-locked door — the key is forwarded on) and returns CROSS_OK.
##     The tear is now permanently open for the rest of the run.
##
## For a POCKET tear (12-tears.md §3, §3a, Reward accounting):
##   - Always returns CROSS_OK — no item cost.
##   - If @a available_pool is non-empty and the pocket pool has not been
##     seeded yet, locks in @a available_pool as the stable pool for this
##     anchor for the rest of the run (INV-6).
##   - Subsequent crossings do not alter the pool regardless of @a available_pool.
##
## @param inventory       Player's current held-item list (mutated on CHAIN first-cross).
## @param available_pool  Source pool for POCKET tears; ignored after first seeding.
## @return CROSS_OK or CROSS_REJECTED_NO_KEY.
func cross(inventory: Array, available_pool: Array = []) -> int:
	if tear_type == TearType.CHAIN:
		if _is_open:
			return CROSS_OK
		if not inventory.has(_required_unique):
			return CROSS_REJECTED_NO_KEY
		inventory.erase(_required_unique)
		_is_open = true
		return CROSS_OK
	# POCKET: free, stable spawn pool (INV-6).
	if _pocket_pool.is_empty() and not available_pool.is_empty():
		_pocket_pool = available_pool.duplicate()
	return CROSS_OK

## Returns true if this CHAIN tear has been crossed at least once and therefore
## does not require the unique item for subsequent crossings. Always returns true
## for POCKET tears, which are never locked (12-tears.md §3 "Re-crossable").
func is_open() -> bool:
	if tear_type == TearType.POCKET:
		return true
	return _is_open

## Returns the pocket's locked-in spawn pool. Empty until the first crossing
## with a non-empty available_pool. Stable thereafter — re-crossing never
## re-rolls or duplicates (INV-6, 12-tears.md §3 Reward accounting).
## Always returns an empty array for CHAIN tears.
func get_pocket_pool() -> Array:
	return _pocket_pool.duplicate()
