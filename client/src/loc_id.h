/**
 * @file loc_id.h
 * @brief LocId — opaque localization identifier (T-0119, 17-localization.md §2).
 *
 * LocId is a POD integer wrapper with **no string conversion of any kind**.
 * It exists to make the type split between "an ID" and "display text" explicit
 * at the C++ layer:
 *
 *   - An ID cannot be rendered: `LocId` has no `to_string()`, no
 *     `operator String()`, and no `operator<<`.
 *   - Display text cannot be sent over the wire or written to the database
 *     (the server only ever sees integer IDs).
 *   - Resolution to display text is possible only through the translation
 *     layer (NoteRenderer, or a future LocResolver).
 *
 * This turns a missed-localization bug into a compile error rather than a
 * raw integer appearing on screen in a shipped build.
 *
 * Usage inside GDExtension C++ code only:
 * @code
 *   LocId tmpl{p_template_id};    // explicit, never implicit
 *   LocId slot_a{p_slot_a};
 *   // resolve through the translation layer:
 *   String text = resolver.resolve(tmpl);
 * @endcode
 *
 * GDScript sees plain `int` at the boundary; the GDExtension API converts
 * to `LocId` internally.  No `LocId` objects cross the GDScript boundary.
 */

#pragma once

#include <cstdint>

namespace godot {

/**
 * @brief Opaque localization identifier — POD integer, no string conversion.
 *
 * Explicit constructor prevents accidental `LocId id = 47;` narrowing.
 * Equality and ordering operators allow use in maps and sorted containers.
 * No `to_string()`, no `operator String()`, no `operator<<` — by design.
 */
struct LocId {
    int32_t value; ///< Raw integer identifier (word ID or template ID).

    /// Explicit constructor — must name the type explicitly; no implicit
    /// conversion from bare integers so misuse is a compile error.
    explicit constexpr LocId(int32_t v) noexcept : value(v) {}

    constexpr bool operator==(const LocId &other) const noexcept { return value == other.value; }
    constexpr bool operator!=(const LocId &other) const noexcept { return value != other.value; }
    constexpr bool operator<(const LocId &other) const noexcept { return value < other.value; }
};

// Explicitly deleted to document intent: LocId cannot be turned into a string.
// Any call to `to_string(loc_id)` is a compile error, not a silent conversion.
void to_string(LocId) = delete;

} // namespace godot
