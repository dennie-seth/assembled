"""Generate Godot 4 import preset files (.import) alongside audio assets (T-0083).

13-asset-pipeline.md §4.7: Godot import presets ensure consistent settings
(loop enabled, streaming, bus assignment) across audio assets landing in
assets/final/audio/. Generated .import files travel with their .ogg files
into the Godot project; the editor reads [params] on first import and fills
in uid/dest_files.

One preset per audio file -- the file is named <name>.ogg.import, matching
Godot 4's convention for resource import metadata files.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class GodotAudioPreset:
    """Parameters written into a Godot 4 AudioStreamOggVorbis .import file.

    Defaults match Godot's own import defaults for a non-looping one-shot
    (loop=False). Callers should set loop=True for music, ambience, and
    collapse-layer assets.
    """

    loop: bool = False
    loop_offset: int = 0
    bpm: float = 0.0
    beat_count: int = 0
    bar_beats: int = 4


def write_godot_import(ogg_path: Path, preset: GodotAudioPreset) -> Path:
    """Write a Godot 4 .import file for `ogg_path` and return its path.

    The generated file follows the minimal format Godot 4 accepts when an
    asset is placed in res:// without a pre-existing .import file: a [remap]
    block naming the importer and a [params] block with the audio settings.
    Godot fills in uid and dest_files on the first import scan.

    The file is named `<ogg_path>.import` (e.g. music.ogg -> music.ogg.import),
    consistent with Godot 4's naming convention for imported resource metadata.
    """
    loop_str = "true" if preset.loop else "false"
    content = (
        "[remap]\n"
        "\n"
        'importer="AudioStreamOggVorbis"\n'
        'type="AudioStreamOggVorbis"\n'
        "\n"
        "[params]\n"
        "\n"
        f"loop={loop_str}\n"
        f"loop_offset={preset.loop_offset}\n"
        f"bpm={preset.bpm}\n"
        f"beat_count={preset.beat_count}\n"
        f"bar_beats={preset.bar_beats}\n"
    )
    import_path = ogg_path.parent / (ogg_path.name + ".import")
    import_path.write_text(content, encoding="utf-8")
    return import_path
