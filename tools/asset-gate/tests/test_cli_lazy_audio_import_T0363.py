"""T-0363: `asset_gate.cli` must stay importable without the audio stack.

`assets/src/character/pyproject.toml` (char-gen) declares only pillow and
numpy -- it deliberately does not declare soundfile/pyloudnorm/scipy, since
those are audio-only dependencies of this package's own `audio-gate`
subcommand. The character test suite's conftest.py sys.path-injects
`tools/asset-gate/src` directly (not via `pip install -e`) specifically so a
plain `pytest` run against a venv built only from char-gen's own [dev] deps
still collects cleanly (see assets/src/character/tests/conftest.py's own
docstring).

Before this fix, `asset_gate/cli.py` did `import soundfile as sf` and
`from asset_gate import art, audio` unconditionally at module level --
`audio.py` itself unconditionally imports `pyloudnorm` and
`scipy.signal` -- so importing `asset_gate.cli` at all, for *any*
subcommand, required the full audio dependency stack to be installed. That
is a real hazard for any caller of `asset_gate.cli` specifically that does
not need the audio stack.

It is NOT, however, a reproduction of the 2026-09-11 "soundfile-related
import failure" report against the character package's own test suite:
nothing under `assets/src/character/tests/` imports `asset_gate.cli` (only
`asset_gate.art`/`.character`/`.palette`/`.determinism`/`.transparency`,
none of which import soundfile/pyloudnorm/scipy), confirmed by actually
collecting that suite in a clean venv built from the package's own
pyproject.toml: 1174 items collected, zero collection errors. See
assets/src/character/CI_KNOWN_FAILURES_T0363.md for the full trace -- that
report's actual trigger is still unidentified. This test still stands on
its own merits: `asset_gate.cli` genuinely should not require the audio
stack to import for a non-audio subcommand, independent of whether it
explains the original report.

RED (pre-fix cli.py): importing asset_gate.cli with soundfile/pyloudnorm/
scipy unavailable raises ImportError, because the module-level
`import soundfile as sf` / `from asset_gate import art, audio` statements
run unconditionally.
GREEN (post-fix cli.py): the same import succeeds, because the audio-stack
imports are deferred into `_cmd_audio_gate`, the only place that needs
them -- every other subcommand still works exactly as before.
"""

from __future__ import annotations

import builtins
import sys

import pytest

_BLOCKED_MODULES = ("soundfile", "pyloudnorm", "scipy")


def _is_blocked(name: str) -> bool:
    return any(name == blocked or name.startswith(f"{blocked}.") for blocked in _BLOCKED_MODULES)


@pytest.fixture
def audio_stack_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    """Simulate a clean char-gen venv: soundfile/pyloudnorm/scipy are not
    installed. Also evicts any already-imported asset_gate.* modules so the
    import under test is a genuine fresh import, not a sys.modules cache
    hit from an earlier test in the same process."""
    real_import = builtins.__import__

    def _fake_import(name: str, *args: object, **kwargs: object) -> object:
        if _is_blocked(name):
            raise ImportError(f"{name!r} intentionally unavailable (T-0363 regression test)")
        return real_import(name, *args, **kwargs)  # type: ignore[arg-type]

    for mod_name in list(sys.modules):
        if mod_name == "asset_gate" or mod_name.startswith("asset_gate."):
            monkeypatch.delitem(sys.modules, mod_name, raising=False)

    monkeypatch.setattr(builtins, "__import__", _fake_import)


def test_cli_importable_without_audio_stack(audio_stack_unavailable: None) -> None:
    """`import asset_gate.cli` must succeed even when soundfile, pyloudnorm,
    and scipy are all unavailable -- those are audio-gate-only deps."""
    import asset_gate.cli  # noqa: F401

    # The parser itself (and every non-audio subcommand it wires up) must
    # also be buildable without the audio stack.
    parser = asset_gate.cli.build_parser()
    assert parser.parse_args(["art-tile-seam", "x.png"]).command == "art-tile-seam"


def test_audio_gate_subcommand_still_wired_up(audio_stack_unavailable: None) -> None:
    """The audio-gate subcommand must still exist in the parser -- deferring
    its imports must not remove the subcommand itself, only delay when its
    dependencies are actually needed."""
    import asset_gate.cli

    parser = asset_gate.cli.build_parser()
    args = parser.parse_args(
        [
            "audio-gate",
            "x.wav",
            "--bus",
            "music",
            "--loudness-targets",
            "targets.json",
        ]
    )
    assert args.command == "audio-gate"
    assert args.func is asset_gate.cli._cmd_audio_gate
