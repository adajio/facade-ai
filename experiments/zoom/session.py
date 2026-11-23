"""Durable, synchronous loop for the synthetic zoom experiment (stdlib only).

``send(request, attempt_dir)`` returns an OpenAI-style chat completion. It may
call ``record_response`` immediately after receipt, before other bookkeeping.
An attempted call without a saved response is NEVER sent again automatically.
``execute_tool(call, tool_dir)`` is a local, idempotent reader: it returns one
matching tool message and optional user image messages. It owns crop/receipt
files in tool_dir. It must not perform paid or other external mutations.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
import tempfile
from typing import Any, Callable


class SessionBusy(RuntimeError):
    """Another process owns this session."""


class KnownProviderFailure(Exception):
    """The sender has positive evidence of a completed, unsuccessful request.

    Do not use for timeouts/disconnections with an unknown upstream outcome.
    The safe detail is persisted. No automatic retry is performed.
    """


class AdmissionDeferred(Exception):
    """The transport positively knows it made NO external request.

    Use only before dispatch, e.g. when a local budget gate rejects admission.
    Never use for a timeout, an HTTP response, or an existing charge reservation.
    A new explicit run_session invocation may try admission again.
    """


def _bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False,
                       separators=(",", ":")) + "\n").encode("utf-8")


def _copy(value: Any) -> Any:
    return json.loads(_bytes(value))


def _read(path: Path) -> Any:
    return json.loads(path.read_bytes())


def _save(path: Path, value: Any, *, once: bool = True) -> None:
    """Commit JSON atomically, fsync file and directory; immutable by default."""
    path.parent.mkdir(parents=True, exist_ok=True)
    data = _bytes(value)
    if once and path.exists():
        if _bytes(_read(path)) != data:
            raise ValueError(f"Persisted evidence differs: {path}")
        return
    fd, tmp = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if once:
            try:
                os.link(tmp, path)
            except FileExistsError:
                if _bytes(_read(path)) != data:
                    raise ValueError(f"Persisted evidence differs: {path}")
        else:
            os.replace(tmp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def record_response(attempt_dir: Path | str, response: dict) -> None:
    """Durably retain a received response, including malformed/error responses.

    Call only while the session owns its lock. The sender must return this same
    JSON object. Existing evidence is compared, never silently overwritten.
    """
    _save(Path(attempt_dir) / "response.json", response)


def certify_admission_deferred(
    session_dir: Path | str, attempt_index: int, *,
    verify_transport: Callable[[Path, dict, dict], dict],
) -> dict:
    """Reclassify a known failure only with positive transport non-send proof.

    The trusted verifier receives (attempt_dir, request, failure), checks its
    own ledger under its lock, and returns a durable JSON receipt containing
    externally_sent=False. It must reject ambiguous outcomes. This function
    holds the session lock and never deletes evidence or makes external calls.
    """
    root = Path(session_dir).resolve()
    directory = root / "attempts" / f"{attempt_index:04d}"
    if attempt_index < 1:
        raise ValueError("A positive attempt index is required")
    with (root / ".lock").open("a+b") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise SessionBusy(str(root)) from exc
        if any((directory / name).exists() for name in
               ("response.json", "sender_error.json", "dispatches")):
            raise ValueError("Attempt has dispatch/response evidence; reclassification forbidden")
        failure_path = directory / "failure.json"
        if not failure_path.exists():
            raise ValueError("Unknown outcomes cannot be reclassified")
        failure = _read(failure_path)
        if failure.get("type") != "KnownProviderFailure":
            raise ValueError("Only a recorded known failure can be reclassified")
        request = _read(directory / "request.json")
        request_hash = hashlib.sha256(_bytes(request)).hexdigest()
        if _read(directory / "pending.json").get("request_sha256") != request_hash:
            raise ValueError("Pending request fingerprint differs")
        receipt = _copy(verify_transport(directory, _copy(request), _copy(failure)))
        if not isinstance(receipt, dict) or receipt.get("externally_sent") is not False:
            raise ValueError("Transport must positively confirm non-dispatch")
        certificate = {
            "kind": "transport_confirmed_not_sent", "version": 1,
            "request_sha256": request_hash,
            "failure_sha256": hashlib.sha256(_bytes(failure)).hexdigest(),
            "transport_receipt": receipt,
        }
        _save(directory / "admission-certificate.json", certificate)
        return certificate


def _admission_certified(directory: Path) -> bool:
    path = directory / "admission-certificate.json"
    if not path.exists():
        return False
    certificate = _read(path)
    failure = _read(directory / "failure.json")
    return (failure.get("type") == "KnownProviderFailure"
            and certificate.get("kind") == "transport_confirmed_not_sent"
            and certificate.get("transport_receipt", {}).get("externally_sent") is False
            and certificate.get("failure_sha256") == hashlib.sha256(_bytes(failure)).hexdigest()
            and certificate.get("request_sha256") == hashlib.sha256(_bytes(_read(directory / "request.json"))).hexdigest())


def _tool_messages(call: dict, messages: Any) -> list[dict]:
    if not isinstance(messages, list) or not messages:
        raise ValueError("Reader must return a nonempty list of messages")
    tool_messages = []
    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in {"tool", "user"}:
            raise ValueError("Reader may return only tool and user image messages")
        if "content" not in message:
            raise ValueError("Reader message lacks content")
        if message["role"] == "tool":
            if message.get("tool_call_id") != call["id"]:
                raise ValueError("Reader returned a different tool_call_id")
            tool_messages.append(message)
    if len(tool_messages) != 1:
        raise ValueError("Reader must return exactly one matching tool message")
    return _copy(messages)


def run_session(
    session_dir: Path | str,
    *,
    initial_messages: list[dict],
    request_options: dict,
    send: Callable[[dict, Path], dict],
    execute_tool: Callable[[dict, Path], list[dict]],
    max_tool_rounds: int = 4,
    reader_binding: dict | None = None,
    synthesis_max_tokens: int | None = None,
) -> dict:
    """Run/replay a session; the same inputs must be supplied on every restart.

    max_tool_rounds counts responses whose requested tools may be executed.
    After the last such response, ALL results are sent once more for synthesis
    with tool_choice=none. Unexpected further tool calls are retained but not
    executed. ``completed`` means an untruncated final answer was received, not
    that its contents passed the experiment's evaluator.
    reader_binding pins source hashes and reader configuration independently of
    manifest v1. Attaching it to an older session requires the caller's prior
    evidence audit; this function cannot verify historical reader inputs.
    synthesis_max_tokens opts into one final synthesis after an empty research
    response truncated by length, only after tool results were delivered. It
    overrides the output limit only on that recovery synthesis. Ordinary drain
    synthesis keeps request_options unchanged. The old manifest
    stays compatible; every previously prepared request remains immutable.
    """
    if isinstance(max_tool_rounds, bool) or not isinstance(max_tool_rounds, int) or max_tool_rounds < 0:
        raise ValueError("max_tool_rounds must be a nonnegative integer")
    if "messages" in request_options:
        raise ValueError("Pass messages through initial_messages")
    if synthesis_max_tokens is not None and (type(synthesis_max_tokens) is not int or synthesis_max_tokens < 1):
        raise ValueError("synthesis_max_tokens must be a positive integer")
    root = Path(session_dir)
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".lock").open("a+b") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise SessionBusy(str(root)) from exc
        binding_path = root / "reader-binding.json"
        if reader_binding is not None:
            if not isinstance(reader_binding, dict):
                raise ValueError("reader_binding must be a JSON object")
            _save(binding_path, reader_binding)
        elif binding_path.exists():
            raise ValueError("reader_binding is required to resume this bound session")
        return _run(root, initial_messages, request_options, send, execute_tool, max_tool_rounds,
                    synthesis_max_tokens)


def _run(root, initial_messages, request_options, send, execute_tool, max_tool_rounds,
         synthesis_max_tokens):
    manifest = _copy({"version": 1, "initial_messages": initial_messages,
                      "request_options": request_options, "max_tool_rounds": max_tool_rounds})
    _save(root / "manifest.json", manifest)
    messages = _copy(initial_messages)
    attempts: list[dict] = []
    prepared: list[dict] = []
    received_ids: set[str] = set()
    calls_started = 0
    replayed = 0
    rounds = 0
    recovery_synthesis = False

    def finish(status, reason=None, final_message=None, unexecuted=None):
        result = {
            "status": status, "reason": reason, "final_message": final_message,
            "final_answer_received": status == "completed",
            "messages": messages, "attempts": attempts, "tool_rounds": rounds,
            "attempt_count": len(attempts), "external_calls_started_this_run": calls_started,
            "replayed_responses": replayed, "prepared_tools": prepared,
            "tool_results_with_response": sorted(received_ids),
            "unexecuted_tool_calls": unexecuted or [],
        }
        _save(root / "result.json", result, once=False)
        return result

    while True:
        index = len(attempts) + 1
        directory = root / "attempts" / f"{index:04d}"
        synthesis = recovery_synthesis or rounds >= max_tool_rounds
        request = _copy(request_options)
        request["messages"] = _copy(messages)
        if synthesis:
            request["tool_choice"] = "none"
            if recovery_synthesis and synthesis_max_tokens is not None:
                if "max_completion_tokens" in request:
                    request["max_completion_tokens"] = synthesis_max_tokens
                    request.pop("max_tokens", None)
                else:
                    request["max_tokens"] = synthesis_max_tokens
        _save(directory / "request.json", request)
        in_request = [m["tool_call_id"] for m in messages if m.get("role") == "tool"]
        attempt = {"index": index, "path": str(directory),
                   "phase": "synthesis" if synthesis else "research",
                   "status": "prepared", "tool_call_ids_in_request": in_request}
        attempts.append(attempt)
        response_path = directory / "response.json"
        dispatches = sorted((directory / "dispatches").glob("[0-9][0-9][0-9][0-9]"))
        attempt["admission_deferrals"] = [
            {"path": str(d), **_read(d / "deferred.json")}
            for d in dispatches if (d / "deferred.json").exists()
        ]
        attempt["dispatch_count"] = len(dispatches)
        retry_admission = bool(dispatches and (dispatches[-1] / "deferred.json").exists())
        certified_legacy = not dispatches and _admission_certified(directory)
        if response_path.exists():
            response = _read(response_path)
            replayed += 1
        elif dispatches and (dispatches[-1] / "failure.json").exists():
            attempt["status"] = "provider_failed"
            return finish("provider_failed", _read(dispatches[-1] / "failure.json"))
        elif dispatches and not retry_admission:
            attempt["status"] = "outcome_unknown"
            return finish("outcome_unknown", "Latest dispatch has no durable outcome; automatic resend forbidden")
        elif not dispatches and (directory / "failure.json").exists() and not certified_legacy:
            attempt["status"] = "provider_failed"
            return finish("provider_failed", _read(directory / "failure.json"))
        elif (directory / "pending.json").exists() and not (retry_admission or certified_legacy):
            attempt["status"] = "outcome_unknown"
            return finish("outcome_unknown", "Attempt has no durable response; automatic resend forbidden")
        else:
            pending = {
                "request_sha256": hashlib.sha256(_bytes(request)).hexdigest(),
                "state": "external_outcome_unknown_until_response_saved",
            }
            _save(directory / "pending.json", pending)
            dispatch = directory / "dispatches" / f"{len(dispatches) + 1:04d}"
            _save(dispatch / "pending.json", pending)
            attempt["dispatch_count"] += 1
            calls_started += 1
            try:
                response = send(_copy(request), directory)
            except Exception as exc:
                # A sender may save the response before its own accounting fails.
                if response_path.exists():
                    response = _read(response_path)
                    _save(dispatch / "sender_error.json", {"type": type(exc).__name__})
                elif isinstance(exc, AdmissionDeferred):
                    deferred = {"type": type(exc).__name__, "detail": str(exc), "externally_sent": False}
                    _save(dispatch / "deferred.json", deferred)
                    calls_started -= 1
                    attempt["admission_deferrals"].append({"path": str(dispatch), **deferred})
                    attempt["status"] = "admission_deferred"
                    return finish("admission_deferred", deferred)
                elif isinstance(exc, KnownProviderFailure):
                    failure = {"type": type(exc).__name__, "detail": str(exc)}
                    _save(dispatch / "failure.json", failure)
                    if not (directory / "failure.json").exists():
                        _save(directory / "failure.json", failure)
                    attempt["status"] = "provider_failed"
                    return finish("provider_failed", failure)
                else:
                    _save(dispatch / "sender_error.json", {"type": type(exc).__name__})
                    attempt["status"] = "outcome_unknown"
                    return finish("outcome_unknown", "Sender stopped without a durable response")
            record_response(directory, response)
        attempt["status"] = "response_received"
        received_ids.update(in_request)
        try:
            choices = response["choices"]
            if not isinstance(choices, list) or len(choices) != 1:
                raise ValueError("Exactly one completion choice is required")
            choice = choices[0]
            message = _copy(choice["message"])
            if message.get("role") != "assistant":
                raise ValueError("Response is not an assistant message")
            calls = message.get("tool_calls") or []
            if not isinstance(calls, list):
                raise ValueError("tool_calls is not an array")
            ids = [call["id"] for call in calls]
            if any(not isinstance(i, str) or not i for i in ids) or len(ids) != len(set(ids)):
                raise ValueError("Tool call IDs must be nonempty and unique in a response")
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            attempt["status"] = "protocol_error"
            return finish("protocol_error", str(exc))
        attempt["finish_reason"] = choice.get("finish_reason")
        content = message.get("content")
        empty_content = content is None or content == "" or content == [] or (
            isinstance(content, str) and not content.strip())
        if (synthesis_max_tokens is not None and not synthesis and
                choice.get("finish_reason") == "length" and empty_content and
                not calls and prepared and in_request):
            # Keep the incomplete assistant in response.json, not in the model
            # context. Continue the same input with one neutral synthesis turn.
            recovery = {"reason": "empty_research_response_truncated_after_tool_results",
                        "next_phase": "synthesis",
                        "response_sha256": hashlib.sha256(_bytes(response)).hexdigest()}
            _save(directory / "recovery.json", recovery)
            attempt["recovery"] = recovery
            messages.append({"role": "user", "content":
                "Дайте краткий итог по имеющимся данным; недоказанное оставьте неопределённым."})
            recovery_synthesis = True
            continue
        messages.append(message)
        if choice.get("finish_reason") not in {"stop", "tool_calls"}:
            return finish("incomplete", "Response did not finish normally", message, calls)
        if not calls:
            content = message.get("content")
            if choice.get("finish_reason") != "stop" or not content or (isinstance(content, str) and not content.strip()):
                return finish("incomplete", "No complete final answer", message)
            return finish("completed", final_message=message)
        if synthesis:
            return finish("incomplete", "Tool calls returned despite synthesis tool_choice=none", message, calls)
        tool_parts = []
        user_parts = []
        for tool_index, call in enumerate(calls, 1):
            tool_dir = directory / "tools" / f"{tool_index:04d}"
            _save(tool_dir / "call.json", call)
            output_path = tool_dir / "messages.json"
            try:
                if output_path.exists():
                    output = _tool_messages(call, _read(output_path))
                else:
                    output = _tool_messages(call, execute_tool(_copy(call), tool_dir))
                    _save(output_path, output)
            except Exception as exc:
                # Local reader work may be retried; the paid response is retained.
                return finish("tool_failed", {"tool_call_id": call["id"], "type": type(exc).__name__},
                              unexecuted=calls[tool_index - 1:])
            prepared.append({"tool_call_id": call["id"], "path": str(tool_dir), "source_attempt": index})
            tool_parts.extend(m for m in output if m["role"] == "tool")
            user_parts.extend(m for m in output if m["role"] == "user")
        # Complete every parallel call before adding auxiliary image messages.
        messages.extend(tool_parts)
        messages.extend(user_parts)
        rounds += 1
