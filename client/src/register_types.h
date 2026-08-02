/**
 * @file register_types.h
 * @brief GDExtension entry point declarations for the assembled client
 *        library.
 */

#pragma once

#include <godot_cpp/core/class_db.hpp>

using namespace godot;

void initialize_assembled_module(ModuleInitializationLevel p_level);
void uninitialize_assembled_module(ModuleInitializationLevel p_level);
