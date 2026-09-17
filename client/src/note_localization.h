#pragma once

/// @file note_localization.h
/// @brief Client-side English display strings for shared/note_templates.hpp
///        word and template IDs.
///
/// Shared between NoteRenderer (T-0064, full note rendering) and NoteCatalog
/// (T-0065, composer dropdown labels) so the two never carry independent
/// copies of the same localization table.

#include <unordered_map>

#include <godot_cpp/variant/string.hpp>

namespace assembled_client {

/// English display strings for all 56 shipped word IDs (shared/note_templates.hpp
/// kWords). OBJECT and HAZARD entries include the definite article "the" as
/// part of the word string; template patterns using those categories do not
/// add an extra "the".
inline const std::unordered_map<int, const char *> kWordStrings = {
    // DIRECTION (ids 1-8)
    {1, "ahead"},
    {2, "behind"},
    {3, "below"},
    {4, "above"},
    {5, "left"},
    {6, "right"},
    {7, "within"},
    {8, "beyond"},
    // HAZARD (ids 9-20) — "the" is part of the word
    {9, "the drop"},
    {10, "the watcher"},
    {11, "the sound"},
    {12, "the cold"},
    {13, "the still air"},
    {14, "the dark"},
    {15, "the heat"},
    {16, "the trap"},
    {17, "the gap"},
    {18, "the edge"},
    {19, "the beast"},
    {20, "the current"},
    // ACTION (ids 21-32)
    {21, "wait"},
    {22, "run"},
    {23, "hide"},
    {24, "cross"},
    {25, "turn back"},
    {26, "listen"},
    {27, "do not"},
    {28, "proceed"},
    {29, "stop"},
    {30, "search"},
    {31, "climb"},
    {32, "descend"},
    // OBJECT (ids 33-48) — "the" is part of the word
    {33, "the door"},
    {34, "the lamp"},
    {35, "the bones"},
    {36, "the machine"},
    {37, "the seam"},
    {38, "the switch"},
    {39, "the lever"},
    {40, "the passage"},
    {41, "the key"},
    {42, "the lock"},
    {43, "the window"},
    {44, "the floor"},
    {45, "the wall"},
    {46, "the ceiling"},
    {47, "the pipe"},
    {48, "the hatch"},
    // QUALIFIER (ids 49-56)
    {49, "slowly"},
    {50, "twice"},
    {51, "never"},
    {52, "only once"},
    {53, "if alone"},
    {54, "carefully"},
    {55, "quietly"},
    {56, "quickly"},
};

/// Format strings for all 20 shipped template IDs.
/// Placeholders: {A} = slot_a word, {B} = slot_b word, {I} = item_ref string.
/// Fixed-phrase templates have no placeholders.
inline const std::unordered_map<int, const char *> kTemplatePatterns = {
    {1, "{A} {B}"},
    {2, "{A} {B}"},
    {3, "{A} {B}"},
    {4, "{A} {B}"},
    {5, "{A}"},
    {6, "{A}"},
    {7, "{A}"},
    {8, "{A} here"},
    {9, "try {A} {B}"},
    {10, "beware {A} {B}"},
    {11, "{A}, {B}"},
    {12, "I need help {A}"},
    {13, "I need {I}"},
    {14, "something is wrong"},
    {15, "{A} opens with {I}"},
    {16, "go {A}"},
    {17, "{A} {B}"},
    {18, "{A} {B}"},
    {19, "watch for {A}"},
    {20, "safe passage"},
};

/// Display label for a shared::WordCategory value (1-5), used to render a
/// template's unfilled slot placeholder for the composer's template dropdown
/// (T-0065 fix round) — e.g. template 1's "{A} {B}" becomes
/// "[action] [qualifier]" rather than a bare id, and distinguishes templates
/// that share the same raw pattern (1-4/17/18 all "{A} {B}"; 5-7 all "{A}").
inline const std::unordered_map<int, const char *> kCategoryLabels = {
    {1, "direction"},
    {2, "hazard"},
    {3, "action"},
    {4, "object"},
    {5, "qualifier"},
};

/// Placeholder substituted for a template pattern's {I} (item_ref) token when
/// rendering a category-only preview label — item_ref has no WordCategory of
/// its own since it is a separate `notes` column, not a word slot.
inline constexpr const char *kItemRefCategoryLabel = "item";

/// Substitute all occurrences of @p token in @p src with @p value. Shared by
/// NoteRenderer (full word substitution) and NoteCatalog (category-label
/// substitution for dropdown item text) so the two never carry independent
/// copies of the same replacement logic.
inline godot::String substitute_token(const godot::String &src, const godot::String &token,
                                      const godot::String &value) {
    return src.replace(token, value);
}

} // namespace assembled_client
