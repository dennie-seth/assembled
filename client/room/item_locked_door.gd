## ItemLockedDoor — opens when the player uses a matching held item (T-0179).
##
## The unlock rule is an exact match on item_id. A use call with a non-matching
## item is rejected; the item is not consumed. On success the item is consumed
## via the "use" transfer verb (03-net-protocol.md §3 — the item circulates,
## the knowledge stays; 10-time-and-progression.md §3) and the door opens.
##
## Solved state: unique-keyed tier (~1 week). Decay and server persistence are
## out of this card's scope (T-0127); this class owns the interaction only.
extends Node

## Result of a use_item() call.
enum UseResult {
	ACCEPTED,  ## Item matched — door is now open, item consumed.
	REJECTED,  ## Item did not match — door unchanged, item not consumed.
}

## The item type ID this door requires to open.
var unlock_item_id: String = ""

## Whether the door has been opened.
var is_open: bool = false

## Emitted when the door is successfully opened.
signal opened(item_id: String)

## Attempt to open this door with the given held item.
##
## @param item_id  The item the player is trying to use.
## @return ACCEPTED if the item matched (door now open, item consumed),
##         REJECTED if not (door unchanged, item not consumed).
func use_item(item_id: String) -> UseResult:
	if is_open:
		return UseResult.ACCEPTED
	if item_id.is_empty() or item_id != unlock_item_id:
		return UseResult.REJECTED
	is_open = true
	opened.emit(item_id)
	return UseResult.ACCEPTED
