"""Atomic temp-file writes (ITD-026). See docs/code-map.md · LLD §8."""
import os
from pathlib import Path
from uuid import uuid4

import numpy as np


def atomic_save_npy(path: Path, arr: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp-{uuid4().hex}")
    with open(tmp, "wb") as f:
        np.save(f, arr, allow_pickle=False)
    os.replace(tmp, path)


def atomic_save_csv(path: Path, arr: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp-{uuid4().hex}")
    with open(tmp, "w", encoding="utf-8") as f:
        np.savetxt(f, arr.reshape(1, -1), fmt="%.8f", delimiter=",")
    os.replace(tmp, path)
