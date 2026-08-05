"""conftest.py — adds lora_train to sys.path so tests run without pip install."""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "src"))
