#pragma once

/// @file shared/note_templates.hpp
/// @brief Single source of truth for note vocabulary and world anchor IDs.
///
/// Included by both server (Drogon/C++) and client (Godot/GDExtension).
/// The SQL seed migration (server/migrations/003_seed_vocab.sql) must stay
/// in parity with these arrays — enforced by seed_parity_test.cpp (T-0043).
///
/// Design references:
///   - docs/design/02-notes-system.md §2 (vocabulary), §3 (anchoring)
///   - docs/design/04-data-model.md §2 (archetype/anchor_tag schema), §5 (notes schema)
///
/// Author: Claude

#include <array>
#include <cstdint>

namespace assembled {

// ─── Word categories ──────────────────────────────────────────────────────────

/// Word slot category.  Stored as the `category` column in `note_words`.
/// Values are stable integers — never renumber, only extend.
enum class WordCategory : int16_t {
    DIRECTION = 1,
    HAZARD = 2,
    ACTION = 3,
    OBJECT = 4,
    QUALIFIER = 5,
};

// ─── Word definitions ─────────────────────────────────────────────────────────

struct WordDef {
    int16_t id;
    WordCategory category;
};

/// All 56 words shipped at launch (02-notes-system.md §2).
/// ID ranges: 1–8 DIRECTION · 9–20 HAZARD · 21–32 ACTION · 33–48 OBJECT · 49–56 QUALIFIER.
/// Grow by appending — existing IDs are permanent localization liabilities.
inline constexpr std::array<WordDef, 56> kWords = {{
    // DIRECTION (8) — ids 1-8
    {1, WordCategory::DIRECTION}, // ahead
    {2, WordCategory::DIRECTION}, // behind
    {3, WordCategory::DIRECTION}, // below
    {4, WordCategory::DIRECTION}, // above
    {5, WordCategory::DIRECTION}, // left
    {6, WordCategory::DIRECTION}, // right
    {7, WordCategory::DIRECTION}, // within
    {8, WordCategory::DIRECTION}, // beyond
    // HAZARD (12) — ids 9-20
    {9, WordCategory::HAZARD},  // the drop
    {10, WordCategory::HAZARD}, // the watcher
    {11, WordCategory::HAZARD}, // the sound
    {12, WordCategory::HAZARD}, // the cold
    {13, WordCategory::HAZARD}, // the still air
    {14, WordCategory::HAZARD}, // the dark
    {15, WordCategory::HAZARD}, // the heat
    {16, WordCategory::HAZARD}, // the trap
    {17, WordCategory::HAZARD}, // the gap
    {18, WordCategory::HAZARD}, // the edge
    {19, WordCategory::HAZARD}, // the beast
    {20, WordCategory::HAZARD}, // the current
    // ACTION (12) — ids 21-32
    {21, WordCategory::ACTION}, // wait
    {22, WordCategory::ACTION}, // run
    {23, WordCategory::ACTION}, // hide
    {24, WordCategory::ACTION}, // cross
    {25, WordCategory::ACTION}, // turn back
    {26, WordCategory::ACTION}, // listen
    {27, WordCategory::ACTION}, // do not
    {28, WordCategory::ACTION}, // proceed
    {29, WordCategory::ACTION}, // stop
    {30, WordCategory::ACTION}, // search
    {31, WordCategory::ACTION}, // climb
    {32, WordCategory::ACTION}, // descend
    // OBJECT (16) — ids 33-48
    {33, WordCategory::OBJECT}, // the door
    {34, WordCategory::OBJECT}, // the lamp
    {35, WordCategory::OBJECT}, // the bones
    {36, WordCategory::OBJECT}, // the machine
    {37, WordCategory::OBJECT}, // the seam
    {38, WordCategory::OBJECT}, // the switch
    {39, WordCategory::OBJECT}, // the lever
    {40, WordCategory::OBJECT}, // the passage
    {41, WordCategory::OBJECT}, // the key
    {42, WordCategory::OBJECT}, // the lock
    {43, WordCategory::OBJECT}, // the window
    {44, WordCategory::OBJECT}, // the floor
    {45, WordCategory::OBJECT}, // the wall
    {46, WordCategory::OBJECT}, // the ceiling
    {47, WordCategory::OBJECT}, // the pipe
    {48, WordCategory::OBJECT}, // the hatch
    // QUALIFIER (8) — ids 49-56
    {49, WordCategory::QUALIFIER}, // slowly
    {50, WordCategory::QUALIFIER}, // twice
    {51, WordCategory::QUALIFIER}, // never
    {52, WordCategory::QUALIFIER}, // only once
    {53, WordCategory::QUALIFIER}, // if alone
    {54, WordCategory::QUALIFIER}, // carefully
    {55, WordCategory::QUALIFIER}, // quietly
    {56, WordCategory::QUALIFIER}, // quickly
}};

// ─── Template definitions ──────────────────────────────────────────────────────

struct TemplateDef {
    int16_t id;
    /// Number of word-slot fillings required (0, 1, or 2).
    /// slot_a is used for slots >= 1; slot_b for slots == 2.
    /// item_ref is a separate column on `notes` and not counted here.
    int16_t slots;
    /// Expected WordCategory (as int16_t) for slot_a; 0 when slots < 1.
    int16_t slot_a_category;
    /// Expected WordCategory (as int16_t) for slot_b; 0 when slots < 2.
    int16_t slot_b_category;
};

/// 20 note templates shipped at launch (02-notes-system.md §2 / §3).
/// Templates that reference ITEM_REF use the `notes.item_ref` column, not a word slot.
/// Category codes: 1=DIRECTION 2=HAZARD 3=ACTION 4=OBJECT 5=QUALIFIER 0=N/A.
inline constexpr std::array<TemplateDef, 20> kTemplates = {{
    {1,  2, 3, 5}, // "{ACTION} {QUALIFIER}"
    {2,  2, 2, 1}, // "{HAZARD} {DIRECTION}"
    {3,  2, 4, 1}, // "{OBJECT} {DIRECTION}"
    {4,  2, 3, 1}, // "{ACTION} {DIRECTION}"
    {5,  1, 2, 0}, // "{HAZARD}"
    {6,  1, 3, 0}, // "{ACTION}"
    {7,  1, 1, 0}, // "{DIRECTION}"
    {8,  1, 4, 0}, // "{OBJECT} here"
    {9,  2, 3, 5}, // "try {ACTION} {QUALIFIER}"
    {10, 2, 2, 1}, // "beware {HAZARD} {DIRECTION}"
    {11, 2, 5, 3}, // "{QUALIFIER}, {ACTION}"
    {12, 1, 1, 0}, // "I need help {DIRECTION}"
    {13, 0, 0, 0}, // "I need {ITEM_REF}"              — item_ref column only
    {14, 0, 0, 0}, // "something is wrong"             — fixed phrase
    {15, 1, 4, 0}, // "{OBJECT} opens with {ITEM_REF}" — slot_a=OBJECT + item_ref
    {16, 1, 1, 0}, // "go {DIRECTION}"
    {17, 2, 3, 4}, // "{ACTION} the {OBJECT}"
    {18, 2, 4, 5}, // "{OBJECT} {QUALIFIER}"
    {19, 1, 2, 0}, // "watch for {HAZARD}"
    {20, 0, 0, 0}, // "safe passage"                   — fixed phrase
}};

// ─── Archetypes ────────────────────────────────────────────────────────────────

/// Archetype IDs.  These are contractual between client and server
/// (02-notes-system.md §3) — never renumber.
enum class ArchetypeId : int16_t {
    HOSPITAL = 1,
    STATION = 2,
    BRIDGE = 3,
    MARKET = 4,
    ARCHIVE = 5,
    SIGNAL_TOWER = 6, ///< Vertical slice archetype (14-vertical-slice.md).
};

/// Flat array of archetype IDs for iteration (SQL seed, parity test).
inline constexpr std::array<int16_t, 6> kArchetypeIds = {1, 2, 3, 4, 5, 6};

// ─── Anchor tags ───────────────────────────────────────────────────────────────

struct AnchorTagDef {
    int16_t archetype_id;
    /// Tag ID, scoped per archetype — (archetype_id, tag) is the PK in DB.
    int16_t tag;
};

/// All anchor tags shipped at launch (04-data-model.md §2).
/// Tags are scoped per archetype: the same tag integer can appear under
/// different archetypes.  31 tags total across 6 archetypes.
/// Only NAMED room anchors appear here — system-facing anchors (Tear, Climax,
/// MusicCue) are defined in kSignalTowerRoomTags, not kAnchorTags.
inline constexpr std::array<AnchorTagDef, 31> kAnchorTags = {{
    // HOSPITAL (archetype 1): 5 tags
    {1, 1}, // entrance
    {1, 2}, // ward_north
    {1, 3}, // ward_south
    {1, 4}, // basement
    {1, 5}, // roof
    // STATION (archetype 2): 4 tags
    {2, 1}, // platform
    {2, 2}, // waiting_room
    {2, 3}, // tracks
    {2, 4}, // booth
    // BRIDGE (archetype 3): 4 tags
    {3, 1}, // approach
    {3, 2}, // midpoint
    {3, 3}, // tower
    {3, 4}, // below
    // MARKET (archetype 4): 5 tags
    {4, 1}, // gate
    {4, 2}, // stalls
    {4, 3}, // back_room
    {4, 4}, // cellar
    {4, 5}, // square
    // ARCHIVE (archetype 5): 6 tags
    {5, 1}, // lobby
    {5, 2}, // stacks
    {5, 3}, // reading_room
    {5, 4}, // vault
    {5, 5}, // rooftop
    {5, 6}, // basement
    // SIGNAL_TOWER (archetype 6): 7 named-room tags for note placement.
    // System-facing anchors (tear/climax/music_cue) are in kSignalTowerRoomTags.
    {6, 1}, // ground_relay
    {6, 2}, // records_room
    {6, 3}, // power_substation
    {6, 4}, // equipment_floor
    {6, 5}, // storage_cache
    {6, 6}, // antenna_shaft
    {6, 7}, // broadcast_deck
}};

// ─── Room-type authoring metadata ─────────────────────────────────────────────

/// Anchor kind — system-facing classification of a declared anchor tag.
/// Climax and Tear are system-facing: the runtime finds them generically across
/// any archetype without per-archetype hardcoding.  Named anchors are
/// author-facing and receive player notes.  (16-level-design.md §1.)
/// Values are stable integers — never renumber, only extend.
enum class AnchorKind : int8_t {
    NAMED     = 0, ///< Ordinary named room anchor; receives player notes.
    CLIMAX    = 1, ///< Dedicated climax anchor; at most 1 per archetype (16 §2).
    TEAR      = 2, ///< Dedicated tear anchor; exactly 1 per archetype (16 §2).
    MUSIC_CUE = 3, ///< Dedicated music-cue anchor; at most 1 per archetype.
};

/// Room role flags — author-facing, composable bitmask (16-level-design.md §1).
/// A room may carry multiple roles simultaneously (e.g. Gate|Hazard).
/// Gate and Hazard attach to a room's own named tag; Tear and Climax use
/// dedicated AnchorKind values instead of role flags.
namespace RoomRole {
    constexpr uint8_t NONE    = 0; ///< No special role (pure Transit).
    constexpr uint8_t GATE    = 1; ///< Required progression gating.
    constexpr uint8_t HAZARD  = 2; ///< Entity-capable slot; sensor-category slot.
    constexpr uint8_t TRANSIT = 4; ///< Connective tissue; no special content.
} // namespace RoomRole

/// Room tag definition — extends AnchorTagDef with anchor-kind and role metadata.
/// The single source of truth for what system-facing role each anchor carries.
struct RoomTagDef {
    int16_t     archetype_id; ///< Archetype this tag belongs to.
    int16_t     tag_id;       ///< Integer tag ID (matches kAnchorTags.tag for NAMED kind).
    const char* tag_name;     ///< Human-readable slug for tooling/debugging.
    AnchorKind  anchor_kind;  ///< System-facing anchor classification.
    uint8_t     roles;        ///< Bitmask of RoomRole flags (author-facing).
};

/// All 10 declared anchor tags for signal_tower (archetype 6).
/// 7 named rooms + tear + climax + music_cue.
/// See docs/design/14-vertical-slice.md §2 and docs/design/16-level-design.md §5.
///
/// Fixed across every variant — INV-12 build check applies to all entries
/// (16 §4: "The anchor tag set — every named room, plus Tear / Climax /
/// music_cue if declared").
inline constexpr std::array<RoomTagDef, 10> kSignalTowerRoomTags = {{
    {6, 1,  "ground_relay",     AnchorKind::NAMED,     RoomRole::TRANSIT},
    {6, 2,  "records_room",     AnchorKind::NAMED,     RoomRole::GATE},
    {6, 3,  "power_substation", AnchorKind::NAMED,     RoomRole::GATE | RoomRole::HAZARD},
    {6, 4,  "equipment_floor",  AnchorKind::NAMED,     RoomRole::HAZARD},
    {6, 5,  "storage_cache",    AnchorKind::NAMED,     RoomRole::TRANSIT},
    {6, 6,  "antenna_shaft",    AnchorKind::NAMED,     RoomRole::HAZARD},
    {6, 7,  "broadcast_deck",   AnchorKind::NAMED,     RoomRole::TRANSIT},
    {6, 8,  "tear",             AnchorKind::TEAR,      RoomRole::NONE},
    {6, 9,  "climax",           AnchorKind::CLIMAX,    RoomRole::NONE},
    {6, 10, "music_cue",        AnchorKind::MUSIC_CUE, RoomRole::NONE},
}};

} // namespace assembled
