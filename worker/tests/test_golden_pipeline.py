"""In-process pipeline golden test. See docs/code-map.md · LLD §8."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from dismean_worker.tasks.generate import run_generate
from dismean_worker.tasks.merge import run_merge
def reference_mean(seed: int, f: int, c: int):
    import numpy as np

    sums = np.zeros(c, dtype=np.int64)
    for idx in range(f):
        rng = np.random.default_rng([seed, idx])
        sums += rng.integers(0, 101, size=c, dtype=np.uint8)
    return sums / f



@pytest.fixture()
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    return tmp_path


def test_five_file_job_mean_matches_reference(data_dir: Path) -> None:
    job_id = "golden"
    f, c, seed = 5, 8, 4242
    paths = [f"jobs/{job_id}/inputs/{i:06d}.npy" for i in range(f)]
    run_generate(
        {
            "schema_version": 1,
            "task_id": "g0",
            "job_id": job_id,
            "attempt": 1,
            "kind": "GENERATE",
            "c": c,
            "generate": {"seed": seed, "file_indices": list(range(f)), "output_paths": paths},
        }
    )
    expected = reference_mean(seed, f, c)
    inputs = [{"item_id": f"i-{i}", "path": paths[i], "count": 1} for i in range(f)]
    run_merge(
        {
            "schema_version": 1,
            "task_id": "final",
            "job_id": job_id,
            "attempt": 1,
            "kind": "MERGE",
            "c": c,
            "merge": {
                "inputs": inputs,
                "output_path": None,
                "final": True,
                "total_count": f,
                "result_paths": {
                    "npy": f"jobs/{job_id}/result.npy",
                    "csv": f"jobs/{job_id}/result.csv",
                },
            },
        }
    )
    got = np.load(data_dir / f"jobs/{job_id}/result.npy")
    assert np.allclose(got, expected, rtol=0, atol=0)
