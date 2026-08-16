## ItemDoorLogic — item-locked door opened only by the matching item.
## §11 §5, T-0179: door is opened by the debug-granted item from T-0171 only.
extends RefCounted

## Sentinel: no item held.
const ITEM_NONE: int = -1

## The item ID required to open this door.
var required_item_id: int = ITEM_NONE

## True once the door has been opened.
var is_open: bool = false

## Attempt to open the door with the given item_id.
## Returns true if door is (or becomes) open, false if item is wrong or absent.
func try_open(item_id: int) -> bool:
	if is_open:
		return true
	if item_id == required_item_id:
		is_open = true
		return true
	return false
