import json

from sfx_synth.cli import main
from sfx_synth.recipes import ALL_RECIPES


def test_render_writes_wav_and_provenance_sidecar(tmp_path, capsys):
    exit_code = main(["render", "footstep_concrete", "--out-dir", str(tmp_path)])
    assert exit_code == 0

    wav_path = tmp_path / "footstep_concrete.wav"
    provenance_path = tmp_path / "footstep_concrete.provenance.json"
    assert wav_path.exists()
    assert provenance_path.exists()

    provenance = json.loads(provenance_path.read_text())
    assert provenance["name"] == "footstep_concrete"
    assert provenance["seed"] == ALL_RECIPES["footstep_concrete"].seed

    printed = json.loads(capsys.readouterr().out)
    assert printed["name"] == "footstep_concrete"
    assert printed["path"] == str(wav_path)


def test_render_is_deterministic_across_invocations(tmp_path):
    main(["render", "switch_click", "--out-dir", str(tmp_path / "a")])
    main(["render", "switch_click", "--out-dir", str(tmp_path / "b")])
    a = (tmp_path / "a" / "switch_click.wav").read_bytes()
    b = (tmp_path / "b" / "switch_click.wav").read_bytes()
    assert a == b


def test_render_unknown_name_fails_cleanly(tmp_path, capsys):
    exit_code = main(["render", "not_a_real_sound", "--out-dir", str(tmp_path)])
    assert exit_code == 1
    assert "not_a_real_sound" in capsys.readouterr().err


def test_render_all_writes_every_recipe(tmp_path):
    exit_code = main(["render-all", "--out-dir", str(tmp_path)])
    assert exit_code == 0
    for name in ALL_RECIPES:
        assert (tmp_path / f"{name}.wav").exists()
        assert (tmp_path / f"{name}.provenance.json").exists()
