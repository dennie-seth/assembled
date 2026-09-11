#include "note_catalog.h"

#include <godot_cpp/core/class_db.hpp>

#include "note_localization.h"

// shared/ is the single source of truth for word/template IDs.
#include "../../shared/note_templates.hpp"

namespace godot {

PackedInt32Array NoteCatalog::get_template_ids() const {
    PackedInt32Array ids;
    for (const auto &t : assembled::kTemplates) {
        ids.push_back(t.id);
    }
    return ids;
}

int NoteCatalog::get_template_slot_count(int p_template_id) const {
    for (const auto &t : assembled::kTemplates) {
        if (t.id == p_template_id) {
            return t.slots;
        }
    }
    return -1;
}

int NoteCatalog::get_template_slot_category(int p_template_id, int p_slot_index) const {
    const assembled::TemplateDef *tdef = nullptr;
    for (const auto &t : assembled::kTemplates) {
        if (t.id == p_template_id) {
            tdef = &t;
            break;
        }
    }
    if (!tdef) {
        return -1;
    }
    if (p_slot_index >= tdef->slots) {
        return 0;
    }
    return (p_slot_index == 0) ? tdef->slot_a_category : tdef->slot_b_category;
}

PackedInt32Array NoteCatalog::get_word_ids_for_category(int p_category) const {
    PackedInt32Array ids;
    for (const auto &w : assembled::kWords) {
        if (static_cast<int>(w.category) == p_category) {
            ids.push_back(w.id);
        }
    }
    return ids;
}

int NoteCatalog::get_word_category(int p_word_id) const {
    for (const auto &w : assembled::kWords) {
        if (w.id == p_word_id) {
            return static_cast<int>(w.category);
        }
    }
    return -1;
}

String NoteCatalog::get_word_label(int p_word_id) const {
    auto it = assembled_client::kWordStrings.find(p_word_id);
    if (it == assembled_client::kWordStrings.end()) {
        return String();
    }
    return String(it->second);
}

void NoteCatalog::_bind_methods() {
    ClassDB::bind_method(D_METHOD("get_template_ids"), &NoteCatalog::get_template_ids);
    ClassDB::bind_method(D_METHOD("get_template_slot_count", "template_id"),
                         &NoteCatalog::get_template_slot_count);
    ClassDB::bind_method(D_METHOD("get_template_slot_category", "template_id", "slot_index"),
                         &NoteCatalog::get_template_slot_category);
    ClassDB::bind_method(D_METHOD("get_word_ids_for_category", "category"),
                         &NoteCatalog::get_word_ids_for_category);
    ClassDB::bind_method(D_METHOD("get_word_category", "word_id"), &NoteCatalog::get_word_category);
    ClassDB::bind_method(D_METHOD("get_word_label", "word_id"), &NoteCatalog::get_word_label);
}

} // namespace godot
