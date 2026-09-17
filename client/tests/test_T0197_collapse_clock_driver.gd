extends SceneTree
## T-0197: CollapseClockDriver — headless test suite.
##
## Verifies that CollapseClockDriver.compute_proximity() correctly maps
## (now, collapse_expires_at, universe_duration_secs) → [0.0, 1.0]:
##
##   1. Proximity = 0.0 at universe birth (now == collapse_expires_at - duration).
##   2. Proximity = 1.0 exactly at collapse (now == collapse_expires_at).
##   3. Proximity = 1.0 past collapse (late/overrun universe).
##   4. Proximity ≈ 0.5 at the halfway point.
##   5. Proximity is monotonically non-decreasing as "now" advances.
##   6. Proximity is clamped to [0.0, 1.0] even for out-of-range inputs.
##   7. Zero (or negative) universe_duration_secs → proximity = 1.0 (fully overrun).
##   8. CollapseClockDriver loads as a GDScript resource without error.
##   9. collapse_proximity_changed signal is emitted by _process_tick()
##      with the correct proximity value.
##  10. No numeric timer or countdown value is emitted — only proximity [0, 1].
##
## Design: compute_proximity() is a pure static function so tests can drive it
## with fixture timestamps without needing Time.get_unix_time_from_system() or
## a running SceneTree clock.
##
## Run headless:
##   cd client && timeout 600 godot --headless --script tests/test_T0197_collapse_clock_driver.gd
## Exit 0 on PASS, 1 on any failure.

const DRIVER_SCRIPT_PATH: String = "res://scripts/collapse_clock_driver.gd"

## Tolerance for floating-point comparisons.
const EPS: float = 1e-5

## Fixture: a 600-second (10-minute) universe.
const UNIVERSE_DURATION: float = 600.0

func _init() -> void:
	var failures: Array[String] = []

	# ── 8. Script loads without error ─────────────────────────────────────────
	var driver_script = load(DRIVER_SCRIPT_PATH)
	if driver_script == null:
		printerr("T-0197 FAIL: could not load '%s' — file missing or parse error" % DRIVER_SCRIPT_PATH)
		quit(1)
		return

	# ── 1. Proximity = 0.0 at universe birth ──────────────────────────────────
	# "now" is exactly (collapse_expires_at - universe_duration) → start of universe.
	var expires: float = 1_000_000.0
	var p_birth: float = driver_script.compute_proximity(
		expires - UNIVERSE_DURATION, expires, UNIVERSE_DURATION
	)
	if not is_zero_approx(p_birth):
		failures.append(
			"birth: proximity at t=0 should be 0.0, got %f" % p_birth
		)

	# ── 2. Proximity = 1.0 exactly at collapse ────────────────────────────────
	var p_collapse: float = driver_script.compute_proximity(
		expires, expires, UNIVERSE_DURATION
	)
	if not is_equal_approx(p_collapse, 1.0):
		failures.append(
			"collapse: proximity at t=duration should be 1.0, got %f" % p_collapse
		)

	# ── 3. Proximity = 1.0 past collapse (overrun) ───────────────────────────
	var p_overrun: float = driver_script.compute_proximity(
		expires + 100.0, expires, UNIVERSE_DURATION
	)
	if not is_equal_approx(p_overrun, 1.0):
		failures.append(
			"overrun: proximity past collapse should be 1.0, got %f" % p_overrun
		)

	# ── 4. Proximity ≈ 0.5 at the midpoint ───────────────────────────────────
	var p_mid: float = driver_script.compute_proximity(
		expires - UNIVERSE_DURATION * 0.5, expires, UNIVERSE_DURATION
	)
	if absf(p_mid - 0.5) > EPS:
		failures.append(
			"midpoint: proximity at t=0.5*duration should be ~0.5, got %f" % p_mid
		)

	# ── 5. Monotonicity: proximity non-decreasing as "now" advances ───────────
	var samples: int = 20
	var prev_p: float = 0.0
	for i: int in range(samples + 1):
		var t_frac: float = float(i) / float(samples)
		var now_t: float = (expires - UNIVERSE_DURATION) + t_frac * UNIVERSE_DURATION
		var p_t: float = driver_script.compute_proximity(now_t, expires, UNIVERSE_DURATION)
		if p_t < prev_p - EPS:
			failures.append(
				"monotonicity: proximity decreased from %f to %f at t_frac=%f"
				% [prev_p, p_t, t_frac]
			)
		prev_p = p_t

	# ── 6. Clamped to [0, 1] for out-of-range inputs ────────────────────────
	# now far in the future (before universe started)
	var p_future: float = driver_script.compute_proximity(
		expires - UNIVERSE_DURATION * 2.0, expires, UNIVERSE_DURATION
	)
	if p_future < 0.0 or p_future > 1.0:
		failures.append(
			"clamp (early): proximity out of [0,1]: got %f" % p_future
		)

	# now far in the past (after universe collapse)
	var p_past: float = driver_script.compute_proximity(
		expires + UNIVERSE_DURATION * 2.0, expires, UNIVERSE_DURATION
	)
	if p_past < 0.0 or p_past > 1.0:
		failures.append(
			"clamp (late): proximity out of [0,1]: got %f" % p_past
		)

	# ── 7. Zero duration → proximity = 1.0 (fully overrun) ───────────────────
	var p_zero_dur: float = driver_script.compute_proximity(expires, expires, 0.0)
	if not is_equal_approx(p_zero_dur, 1.0):
		failures.append(
			"zero_duration: proximity should be 1.0, got %f" % p_zero_dur
		)
	var p_neg_dur: float = driver_script.compute_proximity(expires, expires, -1.0)
	if not is_equal_approx(p_neg_dur, 1.0):
		failures.append(
			"negative_duration: proximity should be 1.0, got %f" % p_neg_dur
		)

	# ── 9. collapse_proximity_changed signal emits correct value ──────────────
	# Instantiate the driver, configure it with fixture timestamps, call
	# _process_tick() with an injected "now" and capture the emitted signal.
	var driver = driver_script.new()
	driver.collapse_expires_at = expires
	driver.universe_duration_secs = UNIVERSE_DURATION

	var emitted_proximities: Array[float] = []
	driver.collapse_proximity_changed.connect(
		func(p: float) -> void:
			emitted_proximities.append(p)
	)

	# Tick at birth.
	var now_birth: float = expires - UNIVERSE_DURATION
	driver._process_tick(now_birth)
	if emitted_proximities.size() != 1:
		failures.append(
			"signal: expected 1 emission after _process_tick(), got %d" % emitted_proximities.size()
		)
	elif not is_zero_approx(emitted_proximities[0]):
		failures.append(
			"signal: emitted proximity at birth should be 0.0, got %f" % emitted_proximities[0]
		)

	# Tick at collapse.
	emitted_proximities.clear()
	driver._process_tick(expires)
	if emitted_proximities.size() != 1:
		failures.append(
			"signal collapse: expected 1 emission, got %d" % emitted_proximities.size()
		)
	elif not is_equal_approx(emitted_proximities[0], 1.0):
		failures.append(
			"signal collapse: emitted proximity should be 1.0, got %f" % emitted_proximities[0]
		)

	# ── 10. No numeric timer value emitted — only proximity [0, 1] ───────────
	# The signal carries a float in [0, 1], never a raw countdown in seconds.
	# Verified structurally: compute_proximity() returns the clamped normalised
	# value; raw "remaining seconds" would be in [0, UNIVERSE_DURATION] (0..600),
	# so checking the emitted value is within [0, 1] is sufficient.
	emitted_proximities.clear()
	driver._process_tick(expires - UNIVERSE_DURATION * 0.75)
	if emitted_proximities.size() == 1:
		var p_check: float = emitted_proximities[0]
		if p_check < 0.0 or p_check > 1.0:
			failures.append(
				"no_timer: emitted value %f is outside [0,1] — looks like a raw countdown, not proximity" % p_check
			)
		# If it were emitting seconds, it would be ~450; anything > 1 fails.
		if p_check > 1.0:
			failures.append(
				"no_timer: value %f > 1.0 — raw countdown leaked into signal" % p_check
			)
	else:
		failures.append(
			"no_timer: expected 1 emission from _process_tick(), got %d" % emitted_proximities.size()
		)

	# ── Report ─────────────────────────────────────────────────────────────────
	if failures.is_empty():
		print("T-0197 PASS: CollapseClockDriver verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0197 FAIL: %s" % f)
		quit(1)
