"""Golden numeric mean reference. See docs/code-map.md · design-doc §9."""
from __future__ import annotations

import numpy as np


def reference_mean(seed: int, f: int, c: int) -> np.ndarray:
    sums = np.zeros(c, dtype=np.int64)
    for idx in range(f):
        rng = np.random.default_rng([seed, idx])
        sums += rng.integers(0, 101, size=c, dtype=np.uint8)
    return sums / f


def test_golden_mean_matches_worker_generation_formula() -> None:
    for seed, f, c in [(0, 2, 2), (42, 12, 5), (999_999, 7, 100)]:
        expected = reference_mean(seed, f, c)
        stacked = np.stack(
            [
                np.random.default_rng([seed, idx]).integers(0, 101, size=c, dtype=np.uint8)
                for idx in range(f)
            ],
            axis=0,
        )
        got = stacked.astype(np.int64).sum(axis=0) / f
        assert np.array_equal(got, expected)


def test_golden_mean_is_deterministic_per_seed() -> None:
    a = reference_mean(123, 10, 8)
    b = reference_mean(123, 10, 8)
    assert np.array_equal(a, b)
    c = reference_mean(124, 10, 8)
    assert not np.array_equal(a, c)
