## ItemAnchorLogic — single item anchor: pick-up and leave mechanics.
## T-0176/T-0177: same mechanism as any other anchor in the game.
extends RefCounted

## Sentinel: no item present.
const ITEM_NONE: int = -1

## The item ID currently held at this anchor, or ITEM_NONE if empty.
var anchored_item_id: int = ITEM_NONE

## Returns true if an item is currently at this anchor.
func has_item() -> bool:
	return anchored_item_id != ITEM_NONE

## Pick up the item from the anchor.
## Returns the item ID and clears the anchor, or returns ITEM_NONE if empty.
func pick_up() -> int:
	if not has_item():
		return ITEM_NONE
	var id: int = anchored_item_id
	anchored_item_id = ITEM_NONE
	return id

## Place an item at this anchor.
func place_item(item_id: int) -> void:
	anchored_item_id = item_id
