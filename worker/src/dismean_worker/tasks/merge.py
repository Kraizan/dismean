from __future__ import annotations

import numpy as np

from ..config import get_data_dir
from ..messages import MergeTaskMessage
from ..storage import atomic_save_csv, atomic_save_npy


def run_merge(msg: MergeTaskMessage) -> dict[str, int]:
    m = msg["merge"]
    acc = np.zeros(msg["c"], dtype=np.int64)
    for inp in m["inputs"]:
        arr = np.load(get_data_dir() / inp["path"], mmap_mode="r")
        if arr.shape != (msg["c"],):
            raise ValueError(f"bad shape {arr.shape} for {inp['path']}")
        acc += arr
        del arr
    total = sum(inp["count"] for inp in m["inputs"])
    if m["final"]:
        mean = acc / m["total_count"]
        paths = m["result_paths"]
        assert paths is not None
        atomic_save_npy(get_data_dir() / paths["npy"], mean)
        atomic_save_csv(get_data_dir() / paths["csv"], mean)
        return {"count": m["total_count"]}
    assert m["output_path"] is not None
    atomic_save_npy(get_data_dir() / m["output_path"], acc)
    return {"count": total}
