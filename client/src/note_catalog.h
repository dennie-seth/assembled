/**
 * @file note_catalog.h
 * @brief GDExtension class exposing shared/note_templates.hpp template and
 *        word metadata to GDScript for the note composer UI (T-0065).
 */

#pragma once

#include <godot_cpp/classes/ref_counted.hpp>
#include <godot_cpp/core/binder_common.hpp>
#include <godot_cpp/variant/packed_int32_array.hpp>
#include <godot_cpp/variant/string.hpp>

namespace godot {

/**
 * @brief Read-only query interface over shared/note_templates.hpp for the
 *        note composer UI.
 *
 * The composer never hardcodes a template's slot arity/category or a word's
 * category — every lookup here reads shared::kTemplates / shared::kWords
 * directly, so shared/ stays the single source of truth (cpp.md) and the
 * composer's dropdown options can never drift from what the server accepts.
 */
class NoteCatalog : public RefCounted {
    GDCLASS(NoteCatalog, RefCounted)

  public:
    NoteCatalog() = default;
    ~NoteCatalog() override = default;

    /// @return All shipped template IDs, in shared/note_templates.hpp order.
    PackedInt32Array get_template_ids() const;

    /**
     * @brief Number of word slots a template requires.
     * @param p_template_id Template ID from shared::kTemplates.
     * @return 0, 1, or 2; -1 if p_template_id is not a shipped template.
     */
    int get_template_slot_count(int p_template_id) const;

    /**
     * @brief Required word category for one of a template's slots.
     * @param p_template_id Template ID from shared::kTemplates.
     * @param p_slot_index  0 for slot_a, 1 for slot_b.
     * @return WordCategory value (1-5) required at that slot; 0 if the
     *         template does not use a slot at p_slot_index; -1 if
     *         p_template_id is not a shipped template.
     */
    int get_template_slot_category(int p_template_id, int p_slot_index) const;

    /**
     * @brief All word IDs belonging to a category.
     * @param p_category WordCategory value (1-5).
     * @return Word IDs in shared::kWords order; empty if the category is
     *         invalid or has no words.
     */
    PackedInt32Array get_word_ids_for_category(int p_category) const;

    /**
     * @brief Category a word belongs to.
     * @param p_word_id Word ID from shared::kWords.
     * @return WordCategory value (1-5); -1 if p_word_id is not shipped.
     */
    int get_word_category(int p_word_id) const;

    /**
     * @brief English display label for a word (dropdown item text).
     * @param p_word_id Word ID from shared::kWords.
     * @return The word's display string, or "" if p_word_id is not shipped.
     */
    String get_word_label(int p_word_id) const;

  protected:
    static void _bind_methods();
};

} // namespace godot
