class_name ClockProximity
extends RefCounted
## Shared wall-clock proximity ramp math (`10-time-and-progression.md` §5).
##
## Both CollapseClockDriver (T-0197, `collapse_expires_at` /
## `universe_duration_secs`) and BleedClockDriver (T-0122, `bleed_at` /
## `bleed_duration_secs`) count down to a target Unix timestamp and normalise
## the remaining time into a [0.0, 1.0] proximity value that drives a shader
## ramp -- never a raw countdown. The formula is identical for both timers;
## this is the single place it lives, per godot.md's "shared logic belongs in
## an autoload or a GDExtension class, not copy-pasted across scripts."


## Normalise a wall-clock reading into a [0.0, 1.0] proximity value.
##
## @param now           Current Unix time (float seconds since epoch).
## @param target_at     Unix timestamp the clock is counting down to.
## @param duration_secs Total span of the timer in seconds. Values <= 0.0 are
##                       treated as already overdue (returns 1.0).
## @return              0.0 at timer start, 1.0 at or past target_at.
static func compute(now: float, target_at: float, duration_secs: float) -> float:
	if duration_secs <= 0.0:
		return 1.0
	var remaining: float = target_at - now
	# remaining / duration_secs is 1.0 at timer start, 0.0 at target_at.
	return clampf(1.0 - (remaining / duration_secs), 0.0, 1.0)
