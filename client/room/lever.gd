## Lever — activatable switch that delays a positioned entity (T-0179).
##
## Implements the trap/lock mechanism from 11-moment-to-moment.md §3: the
## player pulls the lever against a positioned entity, delaying its
## sensor/movement behaviour. Level design places the lever relative to entity
## routes; this class owns only the activation interaction.
##
## The entity reference is duck-typed (Node). On activation the lever emits
## entity_delayed and, if the entity has an on_delayed(duration_sec) method,
## calls it directly. This keeps the lever decoupled from the specific entity
## type (Three-slice entities card).
extends Node

## The entity this lever is tied to. Set by level design.
var entity: Node = null

## Duration in seconds the entity is delayed on activation. Set by level design.
var delay_duration_sec: float = 5.0

## Whether the lever has been pulled in the current interaction cycle.
var is_activated: bool = false

## Emitted when the lever is pulled. Carries the entity reference and duration.
signal entity_delayed(e: Node, duration_sec: float)

## Pull the lever. Delays the tied entity and emits entity_delayed.
## Calling activate() while already activated is a no-op.
func activate() -> void:
	if is_activated:
		return
	is_activated = true
	entity_delayed.emit(entity, delay_duration_sec)
	if entity != null and entity.has_method("on_delayed"):
		entity.on_delayed(delay_duration_sec)

## Reset the lever so it can be activated again (e.g. entity delay expired).
func reset() -> void:
	is_activated = false
