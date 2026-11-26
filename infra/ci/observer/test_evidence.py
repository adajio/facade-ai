import importlib.metadata
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
import venv
from pathlib import Path
from unittest.mock import patch

from observe import HERE, supervise
from report import Attempt


class EvidenceTests(unittest.TestCase):
    def test_check_deadline_before_accepting_late_progress_or_completion(self):
        for budget, late, expected in (("silence_ms", b"last: 1 OK\n", "silence_ms"),
                                       ("stage_ms", b"", "stage_ms")):
            with self.subTest(budget=budget), tempfile.TemporaryFile("w+b") as stream:
                now = [1.]
                policy = dict(mode="observe-only", silence_ms=None, attempt_ms=None, stage_ms=None)
                policy[budget] = 20
                attempt = Attempt(stream, {"policy": policy}, lambda: now[0])
                read = os.read

                def delayed_read(*args):
                    data = read(*args)
                    if attempt.started is not None and data == late:
                        now[0] += .05
                    return data

                command = "import time; print('first: 1 OK'); time.sleep(.10); print('last: 1 OK')"
                with patch("observe.os.read", side_effect=delayed_read):
                    row = supervise(attempt, [sys.executable, "-uc", command], {"first", "last"}, lambda: False)
                self.assertEqual((row["outcome"], row["limit"]), ("passed", expected))

    def test_redelivery_identifies_the_isolated_executor(self):
        try:
            validator = importlib.metadata.distribution("jsonschema")
        except importlib.metadata.PackageNotFoundError:
            self.skipTest("requires the Contracts validator")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            venv.EnvBuilder(with_pip=False).create(root / "empty")
            run = str(uuid.uuid4())
            args = ["-B", str(HERE / "observe.py"), "--reports", directory, "--run-id", run]
            good = subprocess.run([sys.executable, *args], capture_output=True, timeout=10)
            self.assertEqual(good.returncode, 0, (good.stdout, good.stderr))
            report = root / (run + ".jsonl")
            original = report.read_bytes()
            env = {**os.environ, "PYTHONPATH": str(validator.locate_file(""))}
            empty = str(root / "empty/bin/python")
            duplicate = subprocess.run([empty, *args], env=env, capture_output=True, timeout=10)
            self.assertEqual(duplicate.returncode, 2, duplicate.stdout)
            self.assertEqual(report.read_bytes(), original)
            new_run = str(uuid.uuid4())
            fresh = subprocess.run([empty, *args[:-1], new_run], env=env, capture_output=True, timeout=10)
            self.assertEqual(fresh.returncode, 1)
            last = json.loads((root / (new_run + ".jsonl")).read_text().splitlines()[-1])
            self.assertIsNone(last["environment"]["jsonschema"])

            # Matching dist-info and package code, but no transitive dependencies.
            site = next((root / "empty/lib").glob("python*/site-packages"))
            shutil.copytree(validator.locate_file("jsonschema"), site / "jsonschema")
            metadata = next(Path(validator.locate_file("")).glob("jsonschema-*.dist-info"))
            shutil.copytree(metadata, site / metadata.name)
            broken = subprocess.run([empty, *args], capture_output=True, timeout=10)
            self.assertEqual(broken.returncode, 2, broken.stdout)
            self.assertEqual(report.read_bytes(), original)

    def test_incomplete_saved_coverage_cannot_replay_passed(self):
        with tempfile.TemporaryDirectory() as directory:
            run_id = str(uuid.uuid4())
            cmd = [sys.executable, "-B", str(HERE / "observe.py"), "--reports", directory, "--run-id", run_id]
            try:
                importlib.metadata.version("jsonschema")
            except importlib.metadata.PackageNotFoundError:
                self.skipTest("requires the Contracts validator")
            self.assertEqual(subprocess.run(cmd, capture_output=True, timeout=10).returncode, 0)
            report = Path(directory) / (run_id + ".jsonl")
            rows = [json.loads(line) for line in report.read_text().splitlines()]
            point = rows[2]
            last = {**rows[-1], **{key: point[key] for key in ("checkpoint", "examples", "groups")}}
            report.write_text("".join(json.dumps(row) + "\n" for row in [*rows[:3], last]))
            damaged = report.read_bytes()
            self.assertEqual(subprocess.run(cmd, capture_output=True, timeout=10).returncode, 2)
            self.assertEqual(report.read_bytes(), damaged)
