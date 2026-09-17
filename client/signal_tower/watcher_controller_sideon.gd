class_name WatcherControllerSideon
extends Node
## Sight-cone entity controller for the side-on Signal Tower (§20-a3 / T-0194).
##
## Power Substation hazard: The Watcher sweeps a 90-degree sight cone across
## the side-on floor plane.  Detection is blocked by geometry and cover props
## (unlike sound/proximity sensors).
##
## First-pass parameters from 14 §10; tuning in playtest per 11 M-2.

const SENSOR_CATEGORY: String = "SIGHT_CONE"

## Sight range in tiles (first-pass: 6 tiles from 14 §10).
const SIGHT_RANGE_TILES: float = 6.0

## Half-angle of the sight cone in degrees.
const CONE_HALF_ANGLE_DEG: float = 45.0

## Duration of one sweep pass in seconds (one direction).
const SWEEP_PASS_SEC: float = 4.0

## Pause duration at each sweep extreme in seconds.
const SWEEP_PAUSE_SEC: float = 2.0

## Pixels per tile — must match the project tilemap.
const TILE_SIZE: float = 16.0

## Patrol X bounds — set by the room after instantiation.
var patrol_left_x: float = 0.0
var patrol_right_x: float = 0.0
