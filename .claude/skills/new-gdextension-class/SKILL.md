---
name: new-gdextension-class
description: Scaffolds a registered GDExtension C++ class with its GDScript binding and a gdUnit4 test. Use before hand-writing a new client-side native class.
---

# new-gdextension-class

Used by the `client` agent to start a new GDExtension-backed class. See
`.claude/rules/cpp.md` and `.claude/rules/godot.md` for the conventions this
scaffold follows.

## Steps

1. Write the failing gdUnit4 test first — what should the class expose to
   GDScript, and what should calling it do? This is step one of the `tdd`
   skill, not optional because the scaffold does some of the boilerplate.
2. Create the C++ header/source pair under `client/` following the existing
   GDExtension module layout. The class:
   - inherits the appropriate Godot base (`RefCounted`, `Node`, etc.) per
     what it needs to do,
   - exposes only getters/setters and methods via `ClassDB::bind_method` —
     never a public member variable,
   - documents its public interface Doxygen-style.
3. Register the class in the extension's init function
   (`GDExtensionInitialization` entry point) so it's visible to GDScript.
4. Add the GDScript-side usage (a thin wrapper script or direct
   instantiation, depending on what the card calls for).
5. Build with `scons`, confirm the extension loads and the binding
   round-trips a value to/from GDScript.
6. Run the gdUnit4 test written in step 1, confirm it now passes, then
   continue the normal `tdd` refactor step.
