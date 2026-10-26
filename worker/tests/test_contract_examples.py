"""Parse contracts/examples JSON. See docs/code-map.md · ITD-025."""
import json
from pathlib import Path

import pytest

from dismean_worker.messages import validate_example

EXAMPLES_DIR = Path(__file__).resolve().parent.parent.parent / "contracts" / "examples"


def _example_paths() -> list[Path]:
    if not EXAMPLES_DIR.is_dir():
        return []
    return sorted(EXAMPLES_DIR.glob("*.json"))


@pytest.mark.parametrize("path", _example_paths(), ids=lambda p: p.name)
def test_contract_example_parses(path: Path) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    validate_example(data)


def test_contract_examples_exist() -> None:
    paths = _example_paths()
    assert paths, f"no JSON files in {EXAMPLES_DIR}"
