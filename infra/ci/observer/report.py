"""Private, append-only evidence for a single local Contracts attempt."""

import fcntl
import json
import os
import time
from contextlib import contextmanager
from datetime import datetime, timezone


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


def previous_result(stream, identity):
    """The lock is held. An abandoned attempt must never be dispatched again."""
    stream.seek(0)
    last = None
    offset = 0
    for line in stream:
        if not line.endswith(b"\n"):
            # Only an acknowledged complete line can be used as evidence.
            stream.truncate(offset)
            break
        last = json.loads(line)
        offset += len(line)
    if last is None:
        # Dispatch only happens after a durable queued event.
        return None
    for key in ("schema", "run_id", "stage", "sha", "policy", "input_sha256", "environment"):
        if last[key] != identity[key]:
            raise ValueError("run ID already belongs to another input or policy")
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
