from __future__ import annotations

import json

from conftest import make_block_image
from palette_extract.cli import main


def test_cli_writes_lut_png_and_json_and_prints_report(tmp_path, capsys):
    sheet_path = tmp_path / "sheet.png"
    make_block_image([(10, 10, 10), (200, 30, 30), (60, 120, 60), (245, 245, 245)]).save(
        sheet_path
    )
    out_dir = tmp_path / "out"

    exit_code = main(
        ["--sheet", str(sheet_path), "--n", "4", "--out-dir", str(out_dir), "--name", "test_pal"]
    )
    assert exit_code == 0

    lut_path = out_dir / "test_pal.png"
    json_path = out_dir / "test_pal.json"
    assert lut_path.exists()
    assert json_path.exists()

    data = json.loads(json_path.read_text())
    assert len(data["slots"]) == 4

    report = json.loads(capsys.readouterr().out)
    assert report["n"] == 4
    assert len(report["slots"]) == 4
    assert report["slots"][0]["hex"] == "#0a0a0a"


def test_cli_is_deterministic_across_runs(tmp_path):
    sheet_path = tmp_path / "sheet.png"
    make_block_image([(10, 10, 10), (200, 30, 30), (60, 120, 60), (245, 245, 245)]).save(
        sheet_path
    )

    out_a = tmp_path / "a"
    out_b = tmp_path / "b"
    main(["--sheet", str(sheet_path), "--n", "4", "--out-dir", str(out_a)])
    main(["--sheet", str(sheet_path), "--n", "4", "--out-dir", str(out_b)])

    a_json = json.loads((out_a / "home_palette.json").read_text())
    b_json = json.loads((out_b / "home_palette.json").read_text())
    assert a_json["slots"] == b_json["slots"]

    a_png = (out_a / "home_palette.png").read_bytes()
    b_png = (out_b / "home_palette.png").read_bytes()
    assert a_png == b_png
