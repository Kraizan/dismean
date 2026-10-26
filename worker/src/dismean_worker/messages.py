from __future__ import annotations

from typing import Any, Literal, TypedDict, cast

from .config import MAX_FILES_PER_TASK

SchemaVersion = Literal[1]
TaskKind = Literal["GENERATE", "MERGE"]
WorkerState = Literal["IDLE", "BUSY", "STOPPING", "STOPPED"]


class GeneratePayload(TypedDict):
    seed: int
    file_indices: list[int]
    output_paths: list[str]


class MergeInput(TypedDict):
    item_id: str
    path: str
    count: int


class ResultPaths(TypedDict):
    npy: str
    csv: str


class MergePayload(TypedDict):
    inputs: list[MergeInput]
    output_path: str | None
    final: bool
    total_count: int | None
    result_paths: ResultPaths | None


class TaskMessage(TypedDict):
    schema_version: SchemaVersion
    task_id: str
    job_id: str
    attempt: int
    kind: TaskKind
    c: int
    generate: GeneratePayload
    merge: MergePayload


class GenerateTaskMessage(TypedDict):
    schema_version: SchemaVersion
    task_id: str
    job_id: str
    attempt: int
    kind: Literal["GENERATE"]
    c: int
    generate: GeneratePayload


class MergeTaskMessage(TypedDict):
    schema_version: SchemaVersion
    task_id: str
    job_id: str
    attempt: int
    kind: Literal["MERGE"]
    c: int
    merge: MergePayload


class TaskCompletedOutputMerge(TypedDict):
    count: int


class TaskCompletedOutputGenerate(TypedDict):
    files_written: int


class TaskCompletedMessage(TypedDict):
    schema_version: SchemaVersion
    task_id: str
    job_id: str
    attempt: int
    kind: TaskKind
    worker_id: str
    duration_ms: int
    output: TaskCompletedOutputMerge | TaskCompletedOutputGenerate


class TaskError(TypedDict):
    type: str
    message: str


class TaskFailedMessage(TypedDict):
    schema_version: SchemaVersion
    task_id: str
    job_id: str
    attempt: int
    kind: TaskKind
    worker_id: str
    error: TaskError


class WorkerHeartbeatMessage(TypedDict):
    schema_version: SchemaVersion
    worker_id: str
    hostname: str
    pid: int
    state: WorkerState
    task_id: str | None
    job_id: str | None
    task_kind: TaskKind | None
    tasks_done: int
    started_at: str
    sent_at: str


class JobStoppedMessage(TypedDict):
    schema_version: SchemaVersion
    type: Literal["job.stopped"]
    job_id: str
    status: Literal["CANCELLED", "FAILED"]


def _require_dict(data: Any, label: str) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError(f"{label} must be an object")
    return data


def _require_key(data: dict[str, Any], key: str, label: str) -> Any:
    if key not in data:
        raise ValueError(f"{label} missing required key '{key}'")
    return data[key]


def _require_int(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f"{label} must be an integer")
    return value


def _require_str(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")
    return value


def _require_bool(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{label} must be a boolean")
    return value


def _require_schema_version(data: dict[str, Any]) -> SchemaVersion:
    version = _require_int(_require_key(data, "schema_version", "message"), "schema_version")
    if version != 1:
        raise ValueError(f"unsupported schema_version {version}")
    return 1


def validate_generate_payload(payload: Any) -> GeneratePayload:
    g = _require_dict(payload, "generate")
    seed = _require_int(_require_key(g, "seed", "generate"), "generate.seed")
    if seed < 0:
        raise ValueError("generate.seed must be non-negative")
    file_indices = _require_key(g, "file_indices", "generate")
    output_paths = _require_key(g, "output_paths", "generate")
    if not isinstance(file_indices, list) or not isinstance(output_paths, list):
        raise ValueError("generate.file_indices and generate.output_paths must be arrays")
    if not (1 <= len(file_indices) <= MAX_FILES_PER_TASK):
        raise ValueError(f"generate.file_indices length must be 1..{MAX_FILES_PER_TASK}")
    if len(file_indices) != len(output_paths):
        raise ValueError("generate.file_indices and generate.output_paths must have the same length")
    for i, idx in enumerate(file_indices):
        if not isinstance(idx, int) or isinstance(idx, bool):
            raise ValueError(f"generate.file_indices[{i}] must be an integer")
    for i, path in enumerate(output_paths):
        _require_str(path, f"generate.output_paths[{i}]")
    return {
        "seed": seed,
        "file_indices": file_indices,
        "output_paths": output_paths,
    }


def validate_merge_payload(payload: Any) -> MergePayload:
    m = _require_dict(payload, "merge")
    inputs_raw = _require_key(m, "inputs", "merge")
    if not isinstance(inputs_raw, list):
        raise ValueError("merge.inputs must be an array")
    if not (2 <= len(inputs_raw) <= MAX_FILES_PER_TASK):
        raise ValueError(f"merge.inputs length must be 2..{MAX_FILES_PER_TASK}")
    inputs: list[MergeInput] = []
    for i, inp in enumerate(inputs_raw):
        row = _require_dict(inp, f"merge.inputs[{i}]")
        inputs.append(
            {
                "item_id": _require_str(_require_key(row, "item_id", f"merge.inputs[{i}]"), "item_id"),
                "path": _require_str(_require_key(row, "path", f"merge.inputs[{i}]"), "path"),
                "count": _require_int(_require_key(row, "count", f"merge.inputs[{i}]"), "count"),
            }
        )
    final = _require_bool(_require_key(m, "final", "merge"), "merge.final")
    output_path = _require_key(m, "output_path", "merge")
    total_count = _require_key(m, "total_count", "merge")
    result_paths = _require_key(m, "result_paths", "merge")
    if final:
        if output_path is not None:
            raise ValueError("merge.output_path must be null when final is true")
        if total_count is None or not isinstance(total_count, int) or isinstance(total_count, bool):
            raise ValueError("merge.total_count must be an integer when final is true")
        rp = _require_dict(result_paths, "merge.result_paths")
        result: ResultPaths = {
            "npy": _require_str(_require_key(rp, "npy", "merge.result_paths"), "npy"),
            "csv": _require_str(_require_key(rp, "csv", "merge.result_paths"), "csv"),
        }
        return {
            "inputs": inputs,
            "output_path": None,
            "final": True,
            "total_count": total_count,
            "result_paths": result,
        }
    if output_path is None or not isinstance(output_path, str):
        raise ValueError("merge.output_path must be a string when final is false")
    if total_count is not None:
        raise ValueError("merge.total_count must be null when final is false")
    if result_paths is not None:
        raise ValueError("merge.result_paths must be null when final is false")
    return {
        "inputs": inputs,
        "output_path": output_path,
        "final": False,
        "total_count": None,
        "result_paths": None,
    }


def validate_task_message(data: Any) -> GenerateTaskMessage | MergeTaskMessage:
    msg = _require_dict(data, "task message")
    _require_schema_version(msg)
    task_id = _require_str(_require_key(msg, "task_id", "task"), "task_id")
    job_id = _require_str(_require_key(msg, "job_id", "task"), "job_id")
    attempt = _require_int(_require_key(msg, "attempt", "task"), "attempt")
    if attempt < 1:
        raise ValueError("attempt must be >= 1")
    kind = _require_str(_require_key(msg, "kind", "task"), "kind")
    c = _require_int(_require_key(msg, "c", "task"), "c")
    if c < 2:
        raise ValueError("c must be >= 2")
    if kind == "GENERATE":
        if "merge" in msg:
            raise ValueError("GENERATE task must not include merge")
        generate = validate_generate_payload(_require_key(msg, "generate", "task"))
        return {
            "schema_version": 1,
            "task_id": task_id,
            "job_id": job_id,
            "attempt": attempt,
            "kind": "GENERATE",
            "c": c,
            "generate": generate,
        }
    if kind == "MERGE":
        if "generate" in msg:
            raise ValueError("MERGE task must not include generate")
        merge = validate_merge_payload(_require_key(msg, "merge", "task"))
        return {
            "schema_version": 1,
            "task_id": task_id,
            "job_id": job_id,
            "attempt": attempt,
            "kind": "MERGE",
            "c": c,
            "merge": merge,
        }
    raise ValueError(f"unknown task kind {kind!r}")


def validate_task_completed(data: Any) -> TaskCompletedMessage:
    msg = _require_dict(data, "task.completed")
    _require_schema_version(msg)
    kind = _require_str(_require_key(msg, "kind", "task.completed"), "kind")
    output = _require_dict(_require_key(msg, "output", "task.completed"), "output")
    if kind == "GENERATE":
        files_written = _require_int(
            _require_key(output, "files_written", "output"), "output.files_written"
        )
        if files_written < 1:
            raise ValueError("output.files_written must be >= 1")
        out: TaskCompletedOutputGenerate | TaskCompletedOutputMerge = {"files_written": files_written}
    elif kind == "MERGE":
        count = _require_int(_require_key(output, "count", "output"), "output.count")
        if count < 2:
            raise ValueError("output.count must be >= 2")
        out = {"count": count}
    else:
        raise ValueError(f"unknown task kind {kind!r}")
    return {
        "schema_version": 1,
        "task_id": _require_str(_require_key(msg, "task_id", "task.completed"), "task_id"),
        "job_id": _require_str(_require_key(msg, "job_id", "task.completed"), "job_id"),
        "attempt": _require_int(_require_key(msg, "attempt", "task.completed"), "attempt"),
        "kind": cast(TaskKind, kind),
        "worker_id": _require_str(_require_key(msg, "worker_id", "task.completed"), "worker_id"),
        "duration_ms": _require_int(_require_key(msg, "duration_ms", "task.completed"), "duration_ms"),
        "output": out,
    }


def validate_task_failed(data: Any) -> TaskFailedMessage:
    msg = _require_dict(data, "task.failed")
    _require_schema_version(msg)
    kind = _require_str(_require_key(msg, "kind", "task.failed"), "kind")
    if kind not in ("GENERATE", "MERGE"):
        raise ValueError(f"unknown task kind {kind!r}")
    err = _require_dict(_require_key(msg, "error", "task.failed"), "error")
    return {
        "schema_version": 1,
        "task_id": _require_str(_require_key(msg, "task_id", "task.failed"), "task_id"),
        "job_id": _require_str(_require_key(msg, "job_id", "task.failed"), "job_id"),
        "attempt": _require_int(_require_key(msg, "attempt", "task.failed"), "attempt"),
        "kind": cast(TaskKind, kind),
        "worker_id": _require_str(_require_key(msg, "worker_id", "task.failed"), "worker_id"),
        "error": {
            "type": _require_str(_require_key(err, "type", "error"), "error.type"),
            "message": _require_str(_require_key(err, "message", "error"), "error.message"),
        },
    }


def validate_worker_heartbeat(data: Any) -> WorkerHeartbeatMessage:
    msg = _require_dict(data, "worker.heartbeat")
    _require_schema_version(msg)
    state = _require_str(_require_key(msg, "state", "heartbeat"), "state")
    if state not in ("IDLE", "BUSY", "STOPPING", "STOPPED"):
        raise ValueError(f"invalid heartbeat state {state!r}")
    task_kind_raw = _require_key(msg, "task_kind", "heartbeat")
    task_kind: TaskKind | None
    if task_kind_raw is None:
        task_kind = None
    else:
        task_kind = cast(TaskKind, _require_str(task_kind_raw, "task_kind"))
        if task_kind not in ("GENERATE", "MERGE"):
            raise ValueError(f"invalid task_kind {task_kind!r}")
    task_id = _require_key(msg, "task_id", "heartbeat")
    job_id = _require_key(msg, "job_id", "heartbeat")
    if task_id is not None and not isinstance(task_id, str):
        raise ValueError("task_id must be a string or null")
    if job_id is not None and not isinstance(job_id, str):
        raise ValueError("job_id must be a string or null")
    return {
        "schema_version": 1,
        "worker_id": _require_str(_require_key(msg, "worker_id", "heartbeat"), "worker_id"),
        "hostname": _require_str(_require_key(msg, "hostname", "heartbeat"), "hostname"),
        "pid": _require_int(_require_key(msg, "pid", "heartbeat"), "pid"),
        "state": cast(WorkerState, state),
        "task_id": task_id,
        "job_id": job_id,
        "task_kind": task_kind,
        "tasks_done": _require_int(_require_key(msg, "tasks_done", "heartbeat"), "tasks_done"),
        "started_at": _require_str(_require_key(msg, "started_at", "heartbeat"), "started_at"),
        "sent_at": _require_str(_require_key(msg, "sent_at", "heartbeat"), "sent_at"),
    }


def validate_job_stopped(data: Any) -> JobStoppedMessage:
    msg = _require_dict(data, "job.stopped")
    _require_schema_version(msg)
    msg_type = _require_str(_require_key(msg, "type", "job.stopped"), "type")
    if msg_type != "job.stopped":
        raise ValueError(f"unexpected control type {msg_type!r}")
    status = _require_str(_require_key(msg, "status", "job.stopped"), "status")
    if status not in ("CANCELLED", "FAILED"):
        raise ValueError(f"invalid job.stopped status {status!r}")
    return {
        "schema_version": 1,
        "type": "job.stopped",
        "job_id": _require_str(_require_key(msg, "job_id", "job.stopped"), "job_id"),
        "status": cast(Literal["CANCELLED", "FAILED"], status),
    }


def validate_example(data: Any) -> None:
    """Parse a canonical contracts/examples JSON object (raises ValueError on failure)."""
    obj = _require_dict(data, "example")
    if obj.get("type") == "job.stopped":
        validate_job_stopped(obj)
        return
    if "state" in obj and "hostname" in obj:
        validate_worker_heartbeat(obj)
        return
    if "error" in obj:
        validate_task_failed(obj)
        return
    if "duration_ms" in obj:
        validate_task_completed(obj)
        return
    if "kind" in obj:
        validate_task_message(obj)
        return
    raise ValueError("unrecognized contract example shape")
