"""Reopen the backup's mandatory artifacts through its isolated API."""

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
from runpy import run_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    parser.add_argument("phase", choices=["restored", "corrupt", "repaired"])
    args = parser.parse_args()
    os.umask(0o077)
    expected = json.loads((args.folder / "snapshot-input.json").read_text())
    helpers = run_path(str(Path(__file__).resolve().with_name("diagnose-intake.py")))
    with (args.folder / f"{args.phase}-api.jsonl").open("w") as log:
        api = helpers["Session"](log, os.environ["FACADE_STEP14_PASSWORD"],
                                 "http://127.0.0.1:18084", login="step14_browser")
        checks = {}
        target = expected["evidence"][0]["sha256"]
        for evidence in expected["evidence"]:
            metadata = api.request("GET", f"/api/v1/evidence/{evidence['id']}")[0]
            assert metadata["source"]["versionId"] == expected["versionId"]
            assert metadata["sha256"] == evidence["sha256"]
            if args.phase == "corrupt" and evidence["sha256"] == target:
                error = api.request("GET", metadata["contentUrl"], statuses=(424,))[0]
                assert error["code"] == "reader_artifact_mismatch"
                checks[evidence["branch"]] = "424 reader_artifact_mismatch"
            else:
                actual = api.request("GET", metadata["contentUrl"], parse_json=False)[0]
                assert sha256(actual).hexdigest() == evidence["sha256"]
                checks[evidence["branch"]] = "200 verified"
        original = api.request("GET", expected["original"], parse_json=False)[0]
        assert sha256(original).hexdigest() == expected["sourceHash"]
        assert api.request("GET", expected["sent"])[0] == expected["sentPayload"]
        historical = api.request("GET", expected["historicalExport"], parse_json=False)[0]
        assert sha256(historical).hexdigest() == expected["historicalExportSha256"]
        upload = api.request("GET", f"/api/uploads/{expected['concurrency']['uploadId']}")[0]
        assert upload["status"] == "uploading"
        assert sum(part["length"] for part in upload["parts"]) == expected["concurrency"]["acknowledgedBytes"]
    print(json.dumps({"phase": args.phase, "addressedEvidence": checks,
                      "original": "verified", "historicalSent": "verified",
                      "historicalExport": "verified", "retainedParts": len(upload["parts"])}, indent=2))


if __name__ == "__main__":
    main()
