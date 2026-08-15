extends SceneTree
## T-0180: TearNode — chain (unique-keyed) and pocket (round-trip) crossing logic.
##
## Verifies:
##   - Chain tear without required unique is rejected (CROSS_REJECTED_NO_KEY)
##   - Chain tear first crossing consumes the unique and marks the tear open
##   - Re-crossing an already-open chain tear does not require a unique
##   - Pocket tear is always free to cross (no item cost)
##   - Pocket tear spawn pool is stable across multiple crossings (no re-roll)
##   - Pocket tear pool does not grow on re-crossing (no duplication, INV-6)
##
## Run headless:
##   godot --headless --script tests/test_tear_node.gd
## from client/. Exit 0 on PASS, 1 on any failure.

const TearNode := preload("res://tear_node.gd")

func _init() -> void:
	var failures: Array[String] = []

	failures += _test_chain_rejected_without_key()
	failures += _test_chain_first_cross_opens()
	failures += _test_chain_recross_no_key_required()
	failures += _test_pocket_free_cross()
	failures += _test_pocket_pool_stable()
	failures += _test_pocket_pool_no_duplicate_on_recross()

	if failures.is_empty():
		print("T-0180 PASS: TearNode chain and pocket crossing verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0180 FAIL: " + f)
		quit(1)


## ── Test: chain tear rejected without key ────────────────────────────────────
## A chain tear must return CROSS_REJECTED_NO_KEY when the player's inventory
## does not contain the required unique item (12-tears.md §3, §3a).

func _test_chain_rejected_without_key() -> Array[String]:
	var failures: Array[String] = []
	var tear := TearNode.new(1, "broadcast_deck", TearNode.TearType.CHAIN, "clearance_chit")
	var inventory: Array = []

	var result: int = tear.cross(inventory)
	if result != TearNode.CROSS_REJECTED_NO_KEY:
		failures.append(
			"chain_rejected: expected CROSS_REJECTED_NO_KEY (%d), got %d"
			% [TearNode.CROSS_REJECTED_NO_KEY, result]
		)
	if inventory.size() != 0:
		failures.append("chain_rejected: inventory unexpectedly modified")
	if tear.is_open():
		failures.append("chain_rejected: tear reported open after failed crossing")
	return failures


## ── Test: chain tear first crossing consumes unique and opens ─────────────────
## Crossing with the required unique succeeds, removes it from inventory, and
## marks the tear permanently open for this run (12-tears.md §3a).

func _test_chain_first_cross_opens() -> Array[String]:
	var failures: Array[String] = []
	var tear := TearNode.new(1, "broadcast_deck", TearNode.TearType.CHAIN, "clearance_chit")
	var inventory: Array = ["clearance_chit", "medkit"]

	var result: int = tear.cross(inventory)
	if result != TearNode.CROSS_OK:
		failures.append(
			"chain_first_cross: expected CROSS_OK (%d), got %d"
			% [TearNode.CROSS_OK, result]
		)
	if inventory.has("clearance_chit"):
		failures.append("chain_first_cross: unique still in inventory after crossing")
	if not inventory.has("medkit"):
		failures.append("chain_first_cross: non-key item unexpectedly removed")
	if not tear.is_open():
		failures.append("chain_first_cross: tear not open after successful first crossing")
	return failures


## ── Test: re-crossing an open chain tear requires no unique ───────────────────
## After first crossing the tear stays open — it does not re-lock per crossing,
## and no further item spend is needed (12-tears.md §3, §3a).

func _test_chain_recross_no_key_required() -> Array[String]:
	var failures: Array[String] = []
	var tear := TearNode.new(1, "broadcast_deck", TearNode.TearType.CHAIN, "clearance_chit")
	var inventory: Array = ["clearance_chit"]
	var _unused: int = tear.cross(inventory)  # first crossing — consumes key

	var result: int = tear.cross(inventory)  # second crossing — inventory now empty
	if result != TearNode.CROSS_OK:
		failures.append(
			"chain_recross: expected CROSS_OK on second crossing, got %d" % result
		)
	if inventory.size() != 0:
		failures.append("chain_recross: inventory modified on re-crossing an open tear")
	return failures


## ── Test: pocket tear is free ─────────────────────────────────────────────────
## A pocket tear (terminal archetype) may be crossed freely — no item cost,
## regardless of inventory contents (12-tears.md §3, §3a).

func _test_pocket_free_cross() -> Array[String]:
	var failures: Array[String] = []
	var tear := TearNode.new(3, "roof_exit", TearNode.TearType.POCKET, "")
	var inventory: Array = []

	var result: int = tear.cross(inventory)
	if result != TearNode.CROSS_OK:
		failures.append(
			"pocket_free: expected CROSS_OK with empty inventory, got %d" % result
		)
	if inventory.size() != 0:
		failures.append("pocket_free: inventory unexpectedly modified")
	return failures


## ── Test: pocket tear spawn pool is stable across crossings ───────────────────
## The pocket's content pool is seeded on first crossing and returned identically
## on re-crossing — no re-roll per visit (12-tears.md §3 Reward accounting,
## "draws from the same capped spawn pool per anchor").

func _test_pocket_pool_stable() -> Array[String]:
	var failures: Array[String] = []
	var tear := TearNode.new(3, "roof_exit", TearNode.TearType.POCKET, "")
	var source_pool: Array = ["rare_lens", "old_bandage"]
	var inventory: Array = []

	tear.cross(inventory, source_pool)
	var pool_first: Array = tear.get_pocket_pool()

	tear.cross(inventory, [])  # re-cross with empty source — pool must be unchanged
	var pool_second: Array = tear.get_pocket_pool()

	if pool_first != pool_second:
		failures.append(
			"pocket_stable: pool changed between crossings: %s -> %s"
			% [str(pool_first), str(pool_second)]
		)
	if pool_first != source_pool:
		failures.append(
			"pocket_stable: pool %s does not match source %s"
			% [str(pool_first), str(source_pool)]
		)
	return failures


## ── Test: pocket tear pool does not grow on re-crossing ──────────────────────
## Re-crossing must not duplicate or append to the pool (INV-6,
## 12-tears.md §3 Reward accounting — round-trip + re-crossable within a run).

func _test_pocket_pool_no_duplicate_on_recross() -> Array[String]:
	var failures: Array[String] = []
	var tear := TearNode.new(3, "roof_exit", TearNode.TearType.POCKET, "")
	var source_pool: Array = ["rare_lens", "old_bandage"]
	var inventory: Array = []

	tear.cross(inventory, source_pool)
	var size_after_first: int = tear.get_pocket_pool().size()

	for _i: int in range(5):
		tear.cross(inventory, source_pool)

	var size_after_recross: int = tear.get_pocket_pool().size()
	if size_after_recross != size_after_first:
		failures.append(
			"pocket_no_dup: pool size grew from %d to %d on re-crossing"
			% [size_after_first, size_after_recross]
		)
	return failures
