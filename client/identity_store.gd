## IdentityStore — seed-phrase persistence (T-0066).
##
## Saves the server-issued seed phrase to a local plain-text file on first run
## and loads it on subsequent runs so the client can re-derive the same
## identity via the server (09-identity.md §1, 18-first-run.md §2/§9).
##
## Loss is final: the server stores only the derived token, never the phrase.
## FIRST_RUN_NOTICE contains the verbatim copy for the phrase-reveal screen.
##
## Usage pattern:
##   var phrase := IdentityStore.load_phrase()
##   if phrase.is_empty():
##       # First run: call NoteClient.request_identity(), save the result.
##       client.identity_received.connect(_on_identity_received)
##       client.request_identity()
##   else:
##       # Returning run: re-derive identity using the saved phrase.
##       pass
extends Node

## Path within Godot's user data directory where the phrase is persisted.
## Auto-saved the instant it is received from the server — no manual step.
const PHRASE_FILE := "user://identity.phrase"

## Verbatim copy for the phrase-reveal screen (18-first-run.md §2; 09-identity.md §1).
##
## Loss is stated plainly as a rule of the world, not a warning label.
## Also distinguishes phrase loss from universe collapse — different losses,
## different consequences (09-identity.md §3a).
const FIRST_RUN_NOTICE: String = (
	"This phrase is you. It's already saved at [path] — "
	+ "write it down somewhere else too, if you want.\n"
	+ "Lose it, and there is no way back. No password reset. No support ticket. "
	+ "This is how the world works.\n\n"
	+ "Lose the phrase \u2192 lose everything. Vocabulary, notes, the world itself \u2014 gone.\n"
	+ "Let the universe collapse \u2192 lose that universe's unlocks and whatever you're holding. "
	+ "You keep the phrase, and what you've learned."
)

## Load the phrase from @a path. Returns an empty string if the file does not
## exist. An empty result is the deliberate first-run signal — the caller must
## request a new phrase from the server rather than silently proceeding without
## identity. Do not treat an empty result as an error; treat it as "first run."
static func load_phrase(path: String = PHRASE_FILE) -> String:
	if not FileAccess.file_exists(path):
		return ""
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return ""
	return f.get_as_text().strip_edges()

## Persist @a phrase to @a path. Returns true on success, false on I/O error.
## Called immediately after receiving the phrase from the server so that a
## crash between receive and persist cannot silently discard the identity.
static func save_phrase(phrase: String, path: String = PHRASE_FILE) -> bool:
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		return false
	f.store_string(phrase)
	return true

## Returns true if a saved phrase file exists at @a path.
static func has_phrase(path: String = PHRASE_FILE) -> bool:
	return FileAccess.file_exists(path)

## Returns the OS-level absolute path for @a path, suitable for display in
## the first-run notice at the [path] placeholder.
static func resolve_path(path: String = PHRASE_FILE) -> String:
	return ProjectSettings.globalize_path(path)
