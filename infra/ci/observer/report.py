"""Private, append-only evidence for a single local Contracts attempt."""

import fcntl
import json
import os
import time
from contextlib import contextmanager
from datetime import datetime, timezone


NEXT_EVENTS = {
    None: ("queued",),
    "queued": ("started", "terminal"),
    "started": ("checkpoint", "would_stop", "stop_requested", "terminal"),
    "checkpoint": ("checkpoint", "would_stop", "stop_requested", "terminal"),
    "would_stop": ("checkpoint", "stop_requested", "terminal"),
    "stop_requested": ("terminal",),
    "terminal": (),
}
LIMITS = ("attempt_ms", "stage_ms", "silence_ms")
STOP_REASONS = ("operator_stop", "limit_reached", "executor_left_children")


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


@contextmanager
def open_report(path):
    # Opening before flock never truncates a live or a completed attempt.
    fd = os.open(path, os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a+b") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield stream


def append(stream, row):
    stream.write(json.dumps(row, separators=(",", ":")).encode() + b"\n")
    stream.flush()
    os.fsync(stream.fileno())


def valid_terminal(row, last):
    outcome, verified = row["outcome"], row.get("verified")
    exit_code, cancellation = row.get("exit_code"), row.get("cancellation")
    if exit_code is not None and type(exit_code) is not int:
        return False
    if outcome == "passed":
        return (verified is True and exit_code == 0 and cancellation is None
                and row.get("reason") is None and last["event"] != "stop_requested"
                and last["groups"] > 0)
    if outcome == "observer_lost":
        return (verified is False and cancellation == "unconfirmed" and exit_code is None
                and row.get("timing") == "last_observed")
    if outcome in ("failed", *STOP_REASONS):
        return verified is True
    return outcome in ("launch_failed", "executor_lost", "result_unconfirmed", "cancel_unconfirmed") and verified is False


def validate_row(row, identity, last, checkpoints):
    if not isinstance(row, dict) or any(
        key not in row or type(row[key]) is not type(value) or row[key] != value
        for key, value in identity.items()
    ):
        raise ValueError("run ID already belongs to another input or policy")
    event = row.get("event")
    previous_event = last["event"] if last else None
    if event not in NEXT_EVENTS[previous_event]:
        raise ValueError("invalid report event sequence")
    fields = ("queue_ms", "execution_ms", "groups", "examples")
    if (any(type(row.get(key)) is not int or row[key] < 0 for key in fields)
        or not isinstance(row.get("at"), str) or not row["at"]
        or not {"process_group", "checkpoint", "limit", "outcome"} <= row.keys()
        or row["limit"] not in (None, *LIMITS)):
        raise ValueError("incomplete report event")

    process_group = row["process_group"]
    if event == "started":
        if type(process_group) is not int or process_group <= 0:
            raise ValueError("invalid process group")
    else:
        expected_group = last["process_group"] if last else None
        if type(process_group) is not type(expected_group) or process_group != expected_group:
            raise ValueError("inconsistent process group")

    progress = row["checkpoint"], row["groups"], row["examples"]
    previous_progress = (last["checkpoint"], last["groups"], last["examples"]) if last else (None, 0, 0)
    if event == "checkpoint":
        group, groups, examples = progress
        if (not isinstance(group, str) or not group or group in checkpoints
            or groups != last["groups"] + 1 or examples <= last["examples"]):
            raise ValueError("invalid report checkpoint")
        checkpoints.add(group)
    elif progress != previous_progress:
        raise ValueError("checkpoint does not match previous evidence")

    if event == "terminal":
        if not valid_terminal(row, last):
            raise ValueError("invalid terminal result")
    elif row["outcome"] is not None or (event == "stop_requested" and row.get("reason") not in STOP_REASONS):
        raise ValueError("invalid nonterminal result")


def previous_result(stream, identity, expected=None):
    """The lock is held. An abandoned attempt must never be dispatched again."""
    stream.seek(0)
    last = None
    offset = 0
    checkpoints = set()
    for line in stream:
        if not line.endswith(b"\n"):
            # An acknowledged, validated prefix must establish ownership first.
            if last is None:
                raise ValueError("report has no complete event")
            stream.truncate(offset)
            stream.flush()
            os.fsync(stream.fileno())
            break
        row = json.loads(line)
        validate_row(row, identity, last, checkpoints)
        if row["outcome"] == "passed" and expected is not None and checkpoints != expected:
            raise ValueError("incomplete coverage in saved result")
        last = row
        offset += len(line)
    if last is None:
        # Dispatch only happens after a durable queued event.
        return None
    if last["event"] != "terminal":
        last = {**last, "event": "terminal", "outcome": "observer_lost",
                "cancellation": "unconfirmed", "verified": False, "at": utc_now(),
                "timing": "last_observed"}
        append(stream, last)
    return last


class Attempt:
    def __init__(self, stream, identity, now=time.monotonic):
        self.stream = stream
        self.identity = identity
        self.now = now
        self.queued = now()
        self.started = None
        self.progress = None
        self.process_group = None
        self.checkpoints = {}
        self.last = None
        self.limit = None
        self.event("queued")

    def event(self, event, **fields):
        now = self.now()
        until_start = now if self.started is None else self.started
        row = {
            **self.identity, "event": event, "at": utc_now(),
            "queue_ms": round((until_start - self.queued) * 1000),
            "execution_ms": 0 if self.started is None else round((now - self.started) * 1000),
            "process_group": self.process_group, "checkpoint": self.last, "groups": len(self.checkpoints),
            "examples": sum(self.checkpoints.values()), "limit": self.limit,
            "outcome": None, **fields,
        }
        append(self.stream, row)
        return row

    def start(self, process_group):
        self.started = self.now()
        self.process_group = process_group
        self.event("started")

    def checkpoint(self, group, examples):
        if group in self.checkpoints:
            return
        self.checkpoints[group] = examples
        self.progress = self.now()
        self.last = group
        self.event("checkpoint")

    def exceeded(self):
        if self.started is None:
            return None
        policy = self.identity["policy"]
        deadlines = []
        for key, origin in (("attempt_ms", self.started), ("stage_ms", self.started),
                            ("silence_ms", self.progress)):
            budget = policy[key]
            if origin is not None and budget is not None:
                deadlines.append((origin + budget / 1000, key))
        if not deadlines:
            return None
        deadline, reason = min(deadlines)
        return reason if self.now() >= deadline else None
