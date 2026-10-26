"""GENERATE task: seeded uint8 files (≤5 per task). See docs/code-map.md · LLD §8."""
from __future__ import annotations

import numpy as np

from ..config import get_data_dir
from ..messages import GenerateTaskMessage
from ..storage import atomic_save_npy


def run_generate(msg: GenerateTaskMessage) -> dict[str, int]:
    g = msg["generate"]
    for idx, rel in zip(g["file_indices"], g["output_paths"], strict=True):
        rng = np.random.default_rng([g["seed"], idx])
        arr = rng.integers(0, 101, size=msg["c"], dtype=np.uint8)
        atomic_save_npy(get_data_dir() / rel, arr)
    return {"files_written": len(g["file_indices"])}
