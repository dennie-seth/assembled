extends Node2D
## Dev-env proof-of-life scene (T-0060/T-0061). Calls into the
## AssembledPing GDExtension class on ready and prints the round-trip
## result so a human running the project can see the binding works.
## Automated verification lives in tests/smoke_test.gd, not here.

func _ready() -> void:
	var ping: AssembledPing = AssembledPing.new()
	var result: String = ping.ping()
	print("assembled client dev-env: GDExtension says '%s' (ping_count=%d)" % [result, ping.get_ping_count()])
