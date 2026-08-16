class_name OfflineModeController
extends RefCounted
## T-0067: Offline/degraded mode controller.
##
## Wraps a NoteClient to absorb network failures and present a clean interface
## to the rest of the game:
##
##   - notes_available fires for every fetch attempt.  On success the body is
##     the raw server response; when the server is unreachable the body is "".
##     The game never sees a notes error state — notes are simply absent offline.
##   - server_reachable_changed fires when reachability transitions.
##   - request_completion() returns false and emits completion_blocked with a
##     player-readable reason when the server is unreachable.  The ending
##     requires unique items circulating through the network (INV-13) and
##     cannot be reached offline.

## Emitted for every fetch attempt.  `body` is the raw server response on
## success, or "" when the server is unreachable or returns an error.
signal notes_available(body: String)

## Emitted when server reachability transitions.  `reachable` is true when
## the most recent fetch received any HTTP response, false on timeout or
## network error.
signal server_reachable_changed(reachable: bool)

## Emitted by request_completion() when the ending cannot be reached offline.
## `reason` is a player-readable explanation.
signal completion_blocked(reason: String)

## Player-readable message surfaced when the completion condition is blocked.
## References INV-13 so the player understands why, rather than stalling silently.
const OFFLINE_COMPLETION_REASON: String = (
	"The ending requires unique items circulating through the network (INV-13). "
	+ "Connect to a server to reach the ending."
)

var _reachable: bool = true


## Connect this controller to a NoteClient.  Call once before issuing any
## fetch operations; attaches to notes_fetched for reachability tracking.
##
## @param client  The NoteClient node to monitor.
func attach_note_client(client: NoteClient) -> void:
	client.notes_fetched.connect(_on_notes_fetched)


## Returns true if the server was reachable on the most recent fetch attempt.
## Starts optimistic (true) until a fetch result proves otherwise.
func is_server_reachable() -> bool:
	return _reachable


## Check whether the completion condition is reachable.
##
## Returns false and emits completion_blocked (with a player-readable reason)
## when the server is unreachable.  The ending requires INV-13 uniques
## circulating through the network and cannot be reached offline.
##
## @return true if online and completion is possible; false if offline.
func request_completion() -> bool:
	if not _reachable:
		emit_signal("completion_blocked", OFFLINE_COMPLETION_REASON)
		return false
	return true


func _on_notes_fetched(
		_req_id: int, state: int, _http_status: int, body: String) -> void:
	var was_reachable: bool = _reachable

	match state:
		NoteClient.STATE_OK:
			_reachable = true
			emit_signal("notes_available", body)
		NoteClient.STATE_TIMEOUT, NoteClient.STATE_NETWORK_ERROR:
			# Server unreachable — notes are silently absent, not an error.
			_reachable = false
			emit_signal("notes_available", "")
		NoteClient.STATE_HTTP_4XX, NoteClient.STATE_HTTP_5XX:
			# Got a response (server reachable) but no useful notes.
			_reachable = true
			emit_signal("notes_available", "")
		_:
			emit_signal("notes_available", "")

	if was_reachable != _reachable:
		emit_signal("server_reachable_changed", _reachable)
