/**
 * @file anchor_registry.h
 * @brief GDExtension class that maps authored anchor tags to concrete
 *        in-room positions (T-0176).
 *
 * Rooms declare spawn points by (archetype_id, anchor_tag) pairs.  The
 * registry is the single source of truth for resolving those pairs to a
 * Vector2 position at runtime.  A missing tag is an authoring error that
 * must fail loudly (validate_required_tags + ERR_PRINT) rather than
 * silently returning an incorrect position — see 01-vision.md §7 and the
 * build-time-failure gate in INV-12 / T-0092.
 */

#pragma once

#include <godot_cpp/classes/ref_counted.hpp>
#include <godot_cpp/core/binder_common.hpp>
#include <godot_cpp/variant/array.hpp>
#include <godot_cpp/variant/vector2.hpp>

#include <cstdint>
#include <unordered_map>

namespace godot {

/**
 * @brief Maps (archetype_id, anchor_tag) pairs to Vector2 spawn positions.
 *
 * Usage from GDScript (in a Room scene's _ready()):
 * @code
 *   var registry := AnchorRegistry.new()
 *   registry.register_anchor(1, 1, $EntranceMarker.position)
 *   # build-time gate — halt if any required tag is absent
 *   assert(registry.validate_required_tags(1, [1, 2, 3]))
 *
 *   # at runtime
 *   var pos := registry.resolve(1, 1)  # Vector2 spawn point
 * @endcode
 */
class AnchorRegistry : public RefCounted {
    GDCLASS(AnchorRegistry, RefCounted)

  public:
    AnchorRegistry() = default;
    ~AnchorRegistry() override = default;

    /**
     * @brief Register a spawn position for (archetype_id, tag).
     *
     * Overwrites any existing registration for the same pair.
     *
     * @param archetype_id  Archetype ID from shared/note_templates.hpp kArchetypeIds.
     * @param tag           Anchor tag scoped to that archetype.
     * @param position      In-room spawn position (scene-space coordinates).
     */
    void register_anchor(int archetype_id, int tag, const Vector2 &position);

    /**
     * @brief Return true if (archetype_id, tag) has a registered position.
     *
     * @param archetype_id  Archetype ID.
     * @param tag           Anchor tag.
     * @return true if registered; false otherwise.
     */
    bool has_anchor(int archetype_id, int tag) const;

    /**
     * @brief Resolve (archetype_id, tag) to its registered spawn position.
     *
     * Fails loudly via ERR_FAIL_COND_V_MSG and returns Vector2() when the
     * pair is not registered.  Callers that may receive unregistered tags
     * should call has_anchor() first or validate_required_tags() at scene
     * load.
     *
     * @param archetype_id  Archetype ID.
     * @param tag           Anchor tag.
     * @return Registered Vector2 position, or Vector2() on missing entry.
     */
    Vector2 resolve(int archetype_id, int tag) const;

    /**
     * @brief Validate that every tag in required_tags is registered for
     *        archetype_id.
     *
     * Intended to be called in a Room scene's _ready() as the build-time
     * gate (01-vision.md §7).  Returns false and emits ERR_PRINT for each
     * missing tag so the log clearly identifies the offending anchor.
     *
     * @param archetype_id  Archetype ID whose tags are validated.
     * @param required_tags Array of int anchor tags that must be present.
     * @return true if all required tags are registered; false if any are
     *         absent.
     */
    bool validate_required_tags(int archetype_id, const Array &required_tags) const;

  protected:
    static void _bind_methods();

  private:
    /// Compact key: high 16 bits = archetype_id, low 16 bits = tag.
    /// Both values are small integers (max 6 / max 6 in kAnchorTags), so
    /// there is no risk of collision within the contracted range.
    static int32_t make_key(int archetype_id, int tag) {
        return (static_cast<int32_t>(archetype_id) << 16) | (static_cast<int32_t>(tag) & 0xFFFF);
    }

    std::unordered_map<int32_t, Vector2> anchors_;
};

} // namespace godot
