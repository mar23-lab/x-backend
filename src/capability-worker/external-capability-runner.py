#!/usr/bin/env python3
import hashlib
import json
import os
import pathlib
import sys
import time


CONTRACT = "xlooop.external-capability-adapter.v1"
MAX_TEXT_CHARS = 200_000


def sha256_text(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def write_result(path, payload):
    pathlib.Path(path).write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")


def convert_markitdown(payload, workdir):
    from importlib.metadata import version
    from markitdown import MarkItDown

    filename = pathlib.Path(str(payload.get("filename") or "document")).name
    source_path = workdir / filename
    source_path.write_bytes(__import__("base64").b64decode(payload["content_base64"], validate=True))
    source_hash = hashlib.sha256(source_path.read_bytes()).hexdigest()
    if source_hash != payload.get("source_hash"):
        raise ValueError("source hash mismatch")
    started = time.monotonic()
    result = MarkItDown(enable_plugins=False).convert(str(source_path))
    text = str(getattr(result, "text_content", "") or "").strip()[:MAX_TEXT_CHARS]
    if not text:
        raise ValueError("conversion produced empty text")
    output_hash = sha256_text(text)
    return {
        "extracted_text": text,
        "source_spans": [{"start": 0, "end": len(text), "source_ref": f"sha256:{source_hash}"}],
        "receipt": {
            "capability": "markitdown",
            "tool_version": version("markitdown"),
            "source_hash": source_hash,
            "output_hash": output_hash,
            "latency_ms": round((time.monotonic() - started) * 1000),
            "replayable": True,
        },
    }


def compress_headroom(payload):
    from importlib.metadata import version
    import headroom

    messages = payload.get("messages")
    if not isinstance(messages, list) or len(messages) != 2:
        raise ValueError("two prompt messages required")
    source_hash = sha256_text(json.dumps(messages, separators=(",", ":")))
    if source_hash != payload.get("source_hash"):
        raise ValueError("source hash mismatch")
    started = time.monotonic()
    result = headroom.compress(
        messages,
        model="gpt-4o",
        model_limit=4096,
        optimize=True,
        compress_user_messages=True,
        target_ratio=0.5,
        protect_recent=0,
        protect_analysis_context=False,
    )
    compressed = getattr(result, "messages", messages)
    if not isinstance(compressed, list) or len(compressed) != 2:
        raise ValueError("invalid compressed message shape")
    by_role = {str(item.get("role")): str(item.get("content") or "") for item in compressed}
    if not by_role.get("system") or not by_role.get("user"):
        raise ValueError("compressed prompt is incomplete")
    output_hash = sha256_text(json.dumps(compressed, separators=(",", ":")))
    before = int(getattr(result, "tokens_before", 0) or 0)
    after = int(getattr(result, "tokens_after", 0) or 0)
    reduction = round(((before - after) / before) * 100, 2) if before else 0
    return {
        "system": by_role["system"],
        "user": by_role["user"],
        "receipt": {
            "capability": "headroom",
            "tool_version": version("headroom-ai"),
            "source_hash": source_hash,
            "output_hash": output_hash,
            "latency_ms": round((time.monotonic() - started) * 1000),
            "replayable": True,
            "tokens_before": before,
            "tokens_after": after,
            "token_reduction_pct": reduction,
            "transforms_applied": list(getattr(result, "transforms_applied", []) or []),
            "redaction_count": int(payload.get("redaction_count") or 0),
        },
    }


def main():
    if len(sys.argv) != 3:
        raise SystemExit(2)
    payload = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    if payload.get("schema_id") != CONTRACT:
        raise ValueError("contract mismatch")
    workdir = pathlib.Path("/workspace/job")
    workdir.mkdir(parents=True, exist_ok=True)
    operation = payload.get("operation")
    if operation == "markitdown.convert":
        output = convert_markitdown(payload, workdir)
    elif operation == "headroom.compress":
        output = compress_headroom(payload)
    else:
        raise ValueError("unsupported operation")
    write_result(sys.argv[2], output)


if __name__ == "__main__":
    main()
