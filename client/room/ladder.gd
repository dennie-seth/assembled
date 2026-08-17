## Ladder — vertical/room connector, never gated (T-0179).
##
## A ladder is part of base room layout: always usable, same status as a
## normal unlocked door (11-moment-to-moment.md §5). No unlock rule, no item
## required, no puzzle required. IS_GATED is always false.
extends Node

## Ladders are never gated — always false.
const IS_GATED: bool = false

## The room or region this ladder connects to. Set by level design.
var target_room_id: String = ""

## Use the ladder.
##
## @return Always true — ladders are never blocked.
func use() -> bool:
	return true
