/**
 * @file note_renderer.h
 * @brief GDExtension class that renders a note's template + slot words into
 *        display text using shared/note_templates.hpp as the single source of
 *        truth for all word and template IDs (T-0064).
 */

#pragma once

#include <godot_cpp/classes/ref_counted.hpp>
#include <godot_cpp/core/binder_common.hpp>

namespace godot {

/**
 * @brief Renders a note (template_id + slot word IDs + item_ref) into a
 *        human-readable display string for the Godot client.
 *
 * All 20 shipped templates and all 56 shipped words from
 * shared/note_templates.hpp are covered by the embedded English localization
 * table.  The renderer fails loudly (ERR_FAIL_V_MSG + empty return) rather
 * than producing a garbled or blank string when an unknown ID is supplied.
 *
 * Usage from GDScript:
 * @code
 *   var r := NoteRenderer.new()
 *   var text := r.render(10, 14, 3, "")  # "beware the dark below"
 * @endcode
 */
class NoteRenderer : public RefCounted {
    GDCLASS(NoteRenderer, RefCounted)

  public:
    NoteRenderer() = default;
    ~NoteRenderer() override = default;

    /**
     * @brief Render a note into its localized display string.
     *
     * Substitutes slot words and item_ref into the English template pattern.
     * Validates that every required ID exists in the localization table before
     * building the result; returns "" and logs an error on any missing key.
     *
     * @param p_template_id  Template ID (1–20) from kTemplates in
     *                       shared/note_templates.hpp.
     * @param p_slot_a       Word ID for slot_a from kWords; pass 0 when the
     *                       template does not use slot_a.
     * @param p_slot_b       Word ID for slot_b from kWords; pass 0 when the
     *                       template does not use slot_b.
     * @param p_item_ref     Item reference label (free-form server string used
     *                       by templates 13 and 15); pass "" otherwise.
     * @return Rendered display string, or "" if any localization key is absent.
     */
    String render(int p_template_id, int p_slot_a, int p_slot_b, const String &p_item_ref) const;

    /**
     * @brief Verify that the localization table covers all shipped IDs.
     *
     * Checks that every word ID present in shared/note_templates.hpp kWords
     * and every template ID present in kTemplates has a corresponding entry
     * in the embedded English string tables.  Returns false (and logs an error
     * per missing key) if the tables are incomplete — e.g. after a word was
     * added to the header but the renderer was not updated.
     *
     * @return true if all shipped IDs are covered; false otherwise.
     */
    bool has_complete_localization() const;

  protected:
    static void _bind_methods();
};

} // namespace godot
