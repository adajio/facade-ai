"""Upload one synthetic drawing and read the map made by the deployed worker."""

import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
from runpy import run_path
import subprocess
from time import monotonic, sleep
from uuid import uuid4


HERE = Path(__file__).resolve().parent
FIXTURE = HERE.parents[1] / "src/modules/formats/test/fixtures/schedule.dwg"
DOCKER = ["docker", "--context", "orbstack"]

PROBE = """
import pg from 'pg';
import { converterImage } from './dist/src/modules/converter-port/index.js';
const versionId = process.argv[1];
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
await db.connect();
try {
  const result = await db.query(
    'SELECT m.format, m.physical_units, j.dispatched_at FROM harness_document_maps m ' +
    'JOIN intake_reader_jobs j ON j.version_id=m.version_id WHERE m.version_id=$1', [versionId],
  );
  console.log(JSON.stringify({ map: result.rows[0] ?? null, image: await converterImage('dwg') }));
} finally {
  await db.end();
}
"""


def docker(*args):
    return subprocess.run([*DOCKER, *args], check=True, capture_output=True, text=True).stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--dwg-image", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    args.evidence.mkdir()
    helper = run_path(str(HERE / "diagnose-intake.py"))
    data = FIXTURE.read_bytes()
    original = sha256(data).hexdigest()
    broker_image = docker("inspect", "facade-ai-test-server-converter-broker-1", "--format", "{{.Image}}")
    worker_image = docker("inspect", "facade-ai-test-server-worker-1", "--format", "{{.Image}}")
    first = datetime.now(timezone.utc).isoformat()

    with (args.evidence / "http.jsonl").open("w") as log:
        api = helper["Session"](log, os.environ["FACADE_STEP14_PASSWORD"], helper["ORIGIN"])
        catalog = api.request("POST", "/api/catalogs", {
            "key": f"step14-dwg-{uuid4()}", "name": "Synthetic DWG", "requirements": [],
        })[0]["id"]
        project = api.create_project("Step 14 deployed DWG", catalog)
        receipt = api.create_receipt(project)
        upload = api.declare(receipt, FIXTURE.name, len(data), original)["uploadId"]
        api.put_part(upload, 1, data)
        content = api.publish(upload, receipt)
        version = content.split("/")[-2]
        assert sha256(api.request("GET", content)[0]).hexdigest() == original

        deadline = monotonic() + 90
        while monotonic() < deadline:
            worker = json.loads(docker("exec", "facade-ai-test-server-worker-1", "node",
                                       "--env-file=/run/facade/runtime.env", "--input-type=module",
                                       "-e", PROBE, version))
            if worker["map"] and worker["map"]["dispatched_at"]:
                break
            sleep(1)
        else:
            raise RuntimeError("The deployed worker did not publish the DWG map")
        assert worker["image"] == args.dwg_image
        worker_units = worker["map"]["physical_units"]
        assert worker["map"]["format"] == "dwg" and len(worker_units) == 2
        api_units = api.request("GET", content.removesuffix("/content").replace("/api/", "/api/v1/", 1)
                                + "/reader/units")[0]
        spaces = {unit["locator"]["space"]: unit["id"] for unit in api_units["units"]}
        assert set(spaces) == {"Model", "Paper"}
        assert set(spaces.values()) == {unit["id"] for unit in worker_units}

    last = datetime.now(timezone.utc).isoformat()
    events = docker("events", "--since", first, "--until", last,
                    "--filter", "type=container", "--filter", "label=io.facade.converter-broker",
                    "--format", "{{.Action}} {{.Actor.Attributes.image}} {{.Actor.Attributes.name}}")
    (args.evidence / "converter-events.log").write_text(events + "\n")
    assert any(line.startswith(f"create {args.dwg_image} ") for line in events.splitlines())
    summary = {"source_bytes": len(data), "source_sha256": original, "version": version, "spaces": spaces,
               "broker_image": broker_image, "worker_image": worker_image, "dwg_image": worker["image"],
               "worker_dispatched_at": worker["map"]["dispatched_at"]}
    (args.evidence / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
