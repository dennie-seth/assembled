#include "note_renderer.h"

#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/variant/utility_functions.hpp>

// shared/ is the single source of truth for word/template IDs.
#include "../../shared/note_templates.hpp"

#include <unordered_map>

namespace godot {

// ─── English localization tables ─────────────────────────────────────────────
//
// Word strings are derived from the comments in shared/note_templates.hpp and
// must stay in sync with kWords.  Template format strings use {A} for slot_a,
// {B} for slot_b, and {I} for item_ref.
//
// OBJECT and HAZARD words include the definite article "the" as part of the
// word string (matching kWords comments); template patterns that use these
// categories do not add an extra "the".

namespace {

/// English display strings for all 56 shipped word IDs.
const std::unordered_map<int, const char *> kWordStrings = {
    // DIRECTION (ids 1–8)
    {1, "ahead"},
    {2, "behind"},
    {3, "below"},
    {4, "above"},
    {5, "left"},
    {6, "right"},
    {7, "within"},
    {8, "beyond"},
    // HAZARD (ids 9–20)  — "the" is part of the word
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
    // ACTION (ids 21–32)
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
    // OBJECT (ids 33–48)  — "the" is part of the word
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
    // QUALIFIER (ids 49–56)
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
const std::unordered_map<int, const char *> kTemplatePatterns = {
    {1, "{A} {B}"}, // ACTION QUALIFIER
    {2, "{A} {B}"}, // HAZARD DIRECTION
    {3, "{A} {B}"}, // OBJECT DIRECTION
    {4, "{A} {B}"}, // ACTION DIRECTION
    {5, "{A}"}, // HAZARD
    {6, "{A}"}, // ACTION
    {7, "{A}"}, // DIRECTION
    {8, "{A} here"}, // OBJECT here
    {9, "try {A} {B}"}, // try ACTION QUALIFIER
    {10, "beware {A} {B}"}, // beware HAZARD DIRECTION
    {11, "{A}, {B}"}, // QUALIFIER, ACTION
    {12, "I need help {A}"}, // I need help DIRECTION
    {13, "I need {I}"}, // I need ITEM_REF
    {14, "something is wrong"}, // fixed phrase
    {15, "{A} opens with {I}"}, // OBJECT opens with ITEM_REF
    {16, "go {A}"}, // go DIRECTION
    {17, "{A} {B}"}, // ACTION OBJECT  ("the" is in the OBJECT word)
    {18, "{A} {B}"}, // OBJECT QUALIFIER
    {19, "watch for {A}"}, // watch for HAZARD
    {20, "safe passage"}, // fixed phrase
};

/// Substitute all occurrences of @p token in @p src with @p value.
String substitute(const String &src, const String &token, const String &value) {
    return src.replace(token, value);
}

} // anonymous namespace

// ─── NoteRenderer ────────────────────────────────────────────────────────────

String NoteRenderer::render(int p_template_id, int p_slot_a, int p_slot_b,
                            const String &p_item_ref) const {
    // Look up template pattern.
    auto tpl_it = kTemplatePatterns.find(p_template_id);
    ERR_FAIL_COND_V_MSG(tpl_it == kTemplatePatterns.end(), String(),
                        String("NoteRenderer: unknown template_id ") + String::num(p_template_id) +
                            " — localization key missing");

    const assembled::TemplateDef *tdef = nullptr;
    for (const auto &t : assembled::kTemplates) {
        if (t.id == p_template_id) {
            tdef = &t;
            break;
        }
    }
    // Every entry in kTemplatePatterns must correspond to a kTemplates entry;
    // this is enforced by has_complete_localization() but guard defensively.
    ERR_FAIL_COND_V_MSG(tdef == nullptr, String(),
                        String("NoteRenderer: template_id ") + String::num(p_template_id) +
                            " present in pattern table but absent from kTemplates");

    String result = String(tpl_it->second);

    // Substitute slot_a word.
    if (tdef->slots >= 1) {
        auto word_it = kWordStrings.find(p_slot_a);
        ERR_FAIL_COND_V_MSG(word_it == kWordStrings.end(), String(),
                            String("NoteRenderer: unknown slot_a word_id ") +
                                String::num(p_slot_a) + " — localization key missing");
        result = substitute(result, "{A}", String(word_it->second));
    }

    // Substitute slot_b word.
    if (tdef->slots >= 2) {
        auto word_it = kWordStrings.find(p_slot_b);
        ERR_FAIL_COND_V_MSG(word_it == kWordStrings.end(), String(),
                            String("NoteRenderer: unknown slot_b word_id ") +
                                String::num(p_slot_b) + " — localization key missing");
        result = substitute(result, "{B}", String(word_it->second));
    }

    // Substitute item_ref (templates 13 and 15).
    if (result.contains("{I}")) {
        result = substitute(result, "{I}", p_item_ref);
    }

    return result;
}

bool NoteRenderer::has_complete_localization() const {
    bool complete = true;

    // Verify every kWords entry has a string.
    for (const auto &w : assembled::kWords) {
        if (kWordStrings.find(w.id) == kWordStrings.end()) {
            UtilityFunctions::push_error(String("NoteRenderer: localization missing for word_id ") +
                                         String::num(w.id));
            complete = false;
        }
    }

    // Verify every kTemplates entry has a pattern string.
    for (const auto &t : assembled::kTemplates) {
        if (kTemplatePatterns.find(t.id) == kTemplatePatterns.end()) {
            UtilityFunctions::push_error(
                String("NoteRenderer: localization missing for template_id ") + String::num(t.id));
            complete = false;
        }
    }

    return complete;
}

void NoteRenderer::_bind_methods() {
    ClassDB::bind_method(D_METHOD("render", "template_id", "slot_a", "slot_b", "item_ref"),
                         &NoteRenderer::render);
    ClassDB::bind_method(D_METHOD("has_complete_localization"),
                         &NoteRenderer::has_complete_localization);
}

} // namespace godot
