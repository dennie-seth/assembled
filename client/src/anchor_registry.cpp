#include "anchor_registry.h"

#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/core/error_macros.hpp>
#include <godot_cpp/variant/utility_functions.hpp>

namespace godot {

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

void AnchorRegistry::register_anchor(int archetype_id, int tag, const Vector2 &position) {
    anchors_[make_key(archetype_id, tag)] = position;
}

bool AnchorRegistry::has_anchor(int archetype_id, int tag) const {
    return anchors_.count(make_key(archetype_id, tag)) > 0;
}

Vector2 AnchorRegistry::resolve(int archetype_id, int tag) const {
    auto it = anchors_.find(make_key(archetype_id, tag));
    ERR_FAIL_COND_V_MSG(it == anchors_.end(), Vector2(),
                        String("AnchorRegistry: no anchor registered for archetype=") +
                        String::num_int64(archetype_id) + " tag=" + String::num_int64(tag));
    return it->second;
}

bool AnchorRegistry::validate_required_tags(int archetype_id, const Array &required_tags) const {
    bool all_ok = true;
    for (int i = 0; i < required_tags.size(); ++i) {
        const int tag = static_cast<int>(required_tags[i]);
        if (!has_anchor(archetype_id, tag)) {
            ERR_PRINT(String("AnchorRegistry: missing required anchor for archetype=") +
                      String::num_int64(archetype_id) + " tag=" + String::num_int64(tag));
            all_ok = false;
        }
    }
    return all_ok;
}

// ---------------------------------------------------------------------------
// GDExtension binding
// ---------------------------------------------------------------------------

void AnchorRegistry::_bind_methods() {
    ClassDB::bind_method(D_METHOD("register_anchor", "archetype_id", "tag", "position"),
                         &AnchorRegistry::register_anchor);
    ClassDB::bind_method(D_METHOD("has_anchor", "archetype_id", "tag"),
                         &AnchorRegistry::has_anchor);
    ClassDB::bind_method(D_METHOD("resolve", "archetype_id", "tag"), &AnchorRegistry::resolve);
    ClassDB::bind_method(D_METHOD("validate_required_tags", "archetype_id", "required_tags"),
                         &AnchorRegistry::validate_required_tags);
}

} // namespace godot
