#include "assembled_ping.h"

namespace godot {

String AssembledPing::ping() {
    ping_count_ += 1;
    return String("pong");
}

int AssembledPing::get_ping_count() const { return ping_count_; }

void AssembledPing::set_ping_count(int p_ping_count) { ping_count_ = p_ping_count; }

void AssembledPing::_bind_methods() {
    ClassDB::bind_method(D_METHOD("ping"), &AssembledPing::ping);
    ClassDB::bind_method(D_METHOD("get_ping_count"), &AssembledPing::get_ping_count);
    ClassDB::bind_method(D_METHOD("set_ping_count", "ping_count"), &AssembledPing::set_ping_count);
    ADD_PROPERTY(PropertyInfo(Variant::INT, "ping_count"), "set_ping_count", "get_ping_count");
}

} // namespace godot
