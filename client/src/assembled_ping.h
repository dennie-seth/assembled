/**
 * @file assembled_ping.h
 * @brief Minimal GDExtension class used as the client dev-env proof-of-life
 *        (T-0060/T-0061). No game logic belongs here.
 */

#pragma once

#include <godot_cpp/classes/ref_counted.hpp>
#include <godot_cpp/core/binder_common.hpp>

namespace godot {

/**
 * @brief Trivial RefCounted class exposing one method and one property to
 *        GDScript, proving the C++ <-> GDScript GDExtension binding works
 *        end-to-end.
 */
class AssembledPing : public RefCounted {
    GDCLASS(AssembledPing, RefCounted)

  public:
    AssembledPing() = default;
    ~AssembledPing() override = default;

    /**
     * @brief Returns the literal string "pong" and increments the ping
     *        count, so a caller can observe both the return value and the
     *        property side effect from GDScript.
     * @return The string "pong".
     */
    String ping();

    /**
     * @brief Gets the number of times ping() has been called.
     * @return The current ping count.
     */
    int get_ping_count() const;

    /**
     * @brief Sets the ping count. Exposed so the property is a full
     *        get/set pair, not a read-only value, for binding-test purposes.
     * @param p_ping_count The new ping count.
     */
    void set_ping_count(int p_ping_count);

  protected:
    static void _bind_methods();

  private:
    int ping_count_ = 0;
};

} // namespace godot
