## SwitchLockedGate — opens when switches are activated in the correct order
## (T-0179).
##
## Implements the switch-sequence puzzle type from 11-moment-to-moment.md §6.
## The solved state is session-tier (10-time-and-progression.md §3, hours–days)
## — not permanent. Decay is driven server-side (T-0127, backlog); callers can
## call reset_session() to simulate that decay expiring. This class owns the
## interaction only, not the timer.
extends Node

## The required switch activation order (list of switch IDs).
var required_sequence: Array[int] = []

## Whether the gate is currently solved (session-tier, not permanent).
var is_solved: bool = false

## Emitted when the correct sequence is completed and the gate opens.
signal gate_opened

## Switches activated in the current attempt. Cleared on wrong input or solve.
var _current_sequence: Array[int] = []

## Record that @a switch_id was activated.
## If the accumulated sequence matches required_sequence the gate opens.
## A wrong input at any position resets the attempt silently.
##
## @param switch_id  ID of the switch the player activated.
func activate_switch(switch_id: int) -> void:
	if is_solved:
		return
	_current_sequence.append(switch_id)
	var pos: int = _current_sequence.size() - 1
	if pos >= required_sequence.size() or _current_sequence[pos] != required_sequence[pos]:
		_current_sequence.clear()
		return
	if _current_sequence.size() == required_sequence.size():
		is_solved = true
		_current_sequence.clear()
		gate_opened.emit()

## Expire the session-tier solved state.
##
## Call this when the server reports the unlock has decayed. Persistence and
## the actual decay timer are server-side concerns (T-0127); this method is
## the client-side hook that lets callers drive the state change.
func reset_session() -> void:
	is_solved = false
	_current_sequence.clear()
