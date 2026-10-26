"""Generate/merge task IO tests. See docs/code-map.md · LLD §8."""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pytest

from dismean_worker.tasks.generate import run_generate
from dismean_worker.tasks.merge import run_merge


@pytest.fixture()
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    return tmp_path


def test_generate_writes_uint8_files(data_dir: Path) -> None:
    job_id = "job-1"
    paths = [f"jobs/{job_id}/inputs/{i:06d}.npy" for i in range(3)]
    msg = {
        "schema_version": 1,
        "task_id": "t1",
        "job_id": job_id,
        "attempt": 1,
        "kind": "GENERATE",
        "c": 4,
        "generate": {"seed": 7, "file_indices": [0, 1, 2], "output_paths": paths},
    }
    out = run_generate(msg)
    assert out["files_written"] == 3
    for p in paths:
        arr = np.load(data_dir / p)
        assert arr.dtype == np.uint8
        assert arr.shape == (4,)


def test_merge_final_writes_mean(data_dir: Path) -> None:
    job_id = "job-2"
    c = 3
    inputs = []
    for i in range(2):
        rel = f"jobs/{job_id}/inputs/{i:06d}.npy"
        path = data_dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        np.save(path, np.array([10, 20, 30], dtype=np.uint8))
        inputs.append({"item_id": f"id-{i}", "path": rel, "count": 1})
    msg = {
        "schema_version": 1,
        "task_id": "m1",
        "job_id": job_id,
        "attempt": 1,
        "kind": "MERGE",
        "c": c,
        "merge": {
            "inputs": inputs,
            "output_path": None,
            "final": True,
            "total_count": 2,
            "result_paths": {
                "npy": f"jobs/{job_id}/result.npy",
                "csv": f"jobs/{job_id}/result.csv",
            },
        },
    }
    run_merge(msg)
    mean = np.load(data_dir / f"jobs/{job_id}/result.npy")
    assert np.allclose(mean, [10.0, 20.0, 30.0])
    csv = (data_dir / f"jobs/{job_id}/result.csv").read_text(encoding="utf-8").strip()
    assert csv == "10.00000000,20.00000000,30.00000000"


def test_merge_partial_writes_int64_sum(data_dir: Path) -> None:
    job_id = "job-3"
    rel_a = f"jobs/{job_id}/inputs/000000.npy"
    rel_b = f"jobs/{job_id}/inputs/000001.npy"
    for rel, vals in ((rel_a, [1, 2]), (rel_b, [3, 4])):
        path = data_dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        np.save(path, np.array(vals, dtype=np.uint8))
    out_rel = f"jobs/{job_id}/partials/m1.npy"
    msg = {
        "schema_version": 1,
        "task_id": "m1",
        "job_id": job_id,
        "attempt": 1,
        "kind": "MERGE",
        "c": 2,
        "merge": {
            "inputs": [
                {"item_id": "a", "path": rel_a, "count": 1},
                {"item_id": "b", "path": rel_b, "count": 1},
            ],
            "output_path": out_rel,
            "final": False,
            "total_count": None,
            "result_paths": None,
        },
    }
    run_merge(msg)
    acc = np.load(data_dir / out_rel)
    assert acc.dtype == np.int64
    assert np.array_equal(acc, [4, 6])
