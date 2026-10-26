"""Dispatch GENERATE vs MERGE task handlers. See docs/code-map.md · LLD §8."""
from __future__ import annotations

from typing import Any

from ..messages import GenerateTaskMessage, MergeTaskMessage
from .generate import run_generate
from .merge import run_merge


def run_task(msg: GenerateTaskMessage | MergeTaskMessage) -> dict[str, Any]:
    if msg["kind"] == "GENERATE":
        return run_generate(msg)
    return run_merge(msg)
