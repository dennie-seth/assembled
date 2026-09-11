#include "note_renderer.h"

#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/variant/utility_functions.hpp>

#include "note_localization.h"

// shared/ is the single source of truth for word/template IDs.
#include "../../shared/note_templates.hpp"

namespace godot {

// ─── English localization tables ─────────────────────────────────────────────
//
// kWordStrings / kTemplatePatterns live in note_localization.h, shared with
// NoteCatalog (T-0065) so the two never carry independent copies of the same
// table.

namespace {

using assembled_client::kTemplatePatterns;
using assembled_client::kWordStrings;
using assembled_client::substitute_token;

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
        result = substitute_token(result, "{A}", String(word_it->second));
    }

    // Substitute slot_b word.
    if (tdef->slots >= 2) {
        auto word_it = kWordStrings.find(p_slot_b);
        ERR_FAIL_COND_V_MSG(word_it == kWordStrings.end(), String(),
                            String("NoteRenderer: unknown slot_b word_id ") +
                                String::num(p_slot_b) + " — localization key missing");
        result = substitute_token(result, "{B}", String(word_it->second));
    }

    // Substitute item_ref (templates 13 and 15).
    if (result.contains("{I}")) {
        result = substitute_token(result, "{I}", p_item_ref);
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
