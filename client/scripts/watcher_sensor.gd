## WatcherSensor — sight-cone detection geometry.
## §11 §1: Watcher uses sight-cone sensor only; detection requires angle + range.
## §11 §2: Cover Rect2 array blocks line-of-sight; hiding spot handled externally.
extends RefCounted

## Half-angle of the sight cone in degrees (total cone = 2 * cone_half_angle).
var cone_half_angle: float = 45.0
## Maximum detection range in pixels.
var cone_range: float = 80.0

## Returns true if player_pos falls inside the sight cone of a watcher
## at watcher_pos facing in `facing` direction.
func is_player_in_cone(watcher_pos: Vector2, facing: Vector2, player_pos: Vector2) -> bool:
	var delta: Vector2 = player_pos - watcher_pos
	var dist: float = delta.length()
	if dist > cone_range:
		return false
	if dist == 0.0:
		return true
	var cos_angle: float = delta.normalized().dot(facing.normalized())
	var cos_half: float = cos(deg_to_rad(cone_half_angle))
	return cos_angle >= cos_half

## Returns true if the watcher can detect the player, considering both cone
## geometry and cover rectangles blocking line-of-sight.
## cover_rects is an Array of Rect2 values.
func can_detect(watcher_pos: Vector2, facing: Vector2, player_pos: Vector2, cover_rects: Array) -> bool:
	if not is_player_in_cone(watcher_pos, facing, player_pos):
		return false
	for rect: Rect2 in cover_rects:
		if _segment_intersects_rect(watcher_pos, player_pos, rect):
			return false
	return true

## Liang-Barsky segment-vs-AABB intersection test.
func _segment_intersects_rect(p: Vector2, q: Vector2, rect: Rect2) -> bool:
	var dx: float = q.x - p.x
	var dy: float = q.y - p.y
	var t_enter: float = 0.0
	var t_exit: float = 1.0
	var x_min: float = rect.position.x
	var x_max: float = rect.position.x + rect.size.x
	var y_min: float = rect.position.y
	var y_max: float = rect.position.y + rect.size.y

	if dx == 0.0:
		if p.x < x_min or p.x > x_max:
			return false
	else:
		var t1: float = (x_min - p.x) / dx
		var t2: float = (x_max - p.x) / dx
		if t1 > t2:
			var tmp: float = t1; t1 = t2; t2 = tmp
		t_enter = maxf(t_enter, t1)
		t_exit = minf(t_exit, t2)
		if t_enter > t_exit:
			return false

	if dy == 0.0:
		if p.y < y_min or p.y > y_max:
			return false
	else:
		var t1: float = (y_min - p.y) / dy
		var t2: float = (y_max - p.y) / dy
		if t1 > t2:
			var tmp: float = t1; t1 = t2; t2 = tmp
		t_enter = maxf(t_enter, t1)
		t_exit = minf(t_exit, t2)
		if t_enter > t_exit:
			return false

	return true
