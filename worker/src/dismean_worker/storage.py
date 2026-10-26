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
    line = ",".join(f"{float(x):.8f}" for x in arr.tolist())
    tmp = path.with_name(f"{path.name}.tmp-{uuid4().hex}")
    tmp.write_text(line + "\n", encoding="utf-8")
    os.replace(tmp, path)
