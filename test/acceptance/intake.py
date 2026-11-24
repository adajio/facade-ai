"""Submit one synthetic input directory through the stand's public upload API."""

import argparse
import hashlib
import json
import mimetypes
import os
import ssl
import time
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPSHandler, HTTPCookieProcessor, HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import UUID, uuid4

from score import digest, load, verify_originals


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        return None


class Intake:
    def __init__(self, origin, log, ca_file=None):
        parsed = urlsplit(origin)
        if (parsed.scheme not in {"http", "https"} or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}
                or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):
            raise ValueError("Use the loopback origin of the local acceptance stand")
        self.origin = origin
        tls = HTTPSHandler(context=ssl.create_default_context(cafile=ca_file))
        self.opener = build_opener(ProxyHandler({}), NoRedirect(), HTTPCookieProcessor(CookieJar()), tls)
        self.csrf = None
        self.start = time.monotonic_ns()
        self.log = log

    def request(self, method, path, body=None, part_sha256=None, allowed=(200,), expect_original=False):
        headers = {"Accept": "application/json"}
        if method != "GET":
            headers["Origin"] = self.origin
        idempotency_key = None
        if self.csrf is not None and method != "GET":
            idempotency_key = str(uuid4())
            headers.update({"X-CSRF-Token": self.csrf, "Idempotency-Key": idempotency_key})
        encoded = None
        if part_sha256 is not None:
            encoded = body
            headers.update({"Content-Type": "application/octet-stream", "X-Part-SHA256": part_sha256,
                            "Content-Length": str(len(body))})
        elif body is not None:
            encoded = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        started = time.monotonic_ns()
        request = Request(self.origin + path, data=encoded, method=method, headers=headers)
        try:
            with self.opener.open(request, timeout=90) as response:
                status, raw = response.status, response.read()
                cache = response.headers.get("Cache-Control")
        except HTTPError as error:
            with error:
                status, raw = error.code, error.read()
        except OSError:
            self.append_event(method, path, started, "outcome_unknown", idempotency_key)
            raise
        self.append_event(method, path, started, status, idempotency_key)
        if status not in allowed:
            raise RuntimeError(f"{method} {path} returned HTTP {status}. Inspect the receipt before any retry.")
        if expect_original:
            if "no-store" not in {value.strip().lower() for value in (cache or "").split(",")}:
                raise RuntimeError("Authorized original is missing cache-control no-store")
            return raw
        return json.loads(raw) if raw else None

    def append_event(self, method, path, started, status, idempotency_key):
        self.log.write(json.dumps({
            "method": method, "path": path, "status": status,
            "idempotencyKey": idempotency_key,
            "startNs": started - self.start, "endNs": time.monotonic_ns() - self.start,
        }) + "\n")
        self.log.flush()


def list_inputs(directory):
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("Inputs must be a standalone regular directory")
    entries = sorted(directory.rglob("*"))
    if any(path.is_symlink() or not (path.is_file() or path.is_dir()) for path in entries):
        raise ValueError("Input contains a symlink or nonregular file")
    files = [path for path in entries if path.is_file()]
    if not files:
        raise ValueError("Input directory is empty")
    return files


def login(api):
    api.request("GET", "/readyz")
    session = api.request("POST", "/api/sessions", {
        "login": os.environ["FACADE_ACCEPTANCE_LOGIN"], "password": os.environ["FACADE_ACCEPTANCE_PASSWORD"],
    }, allowed=(200, 201))
    api.csrf = session["csrfToken"]


def create_project(api, profile, results):
    login(api)
    catalog = api.request("POST", "/api/catalogs", profile["catalog"], allowed=(201,))
    project = api.request("POST", "/api/projects", {
        **profile["project"], "catalogVersionId": str(UUID(catalog["id"])),
    }, allowed=(201,))
    project_id = UUID(project["id"])
    for scope in profile["scopes"]:
        api.request("POST", f"/api/projects/{project_id}/scopes", scope, allowed=(201,))
    configured = api.request("GET", f"/api/projects/{project_id}")
    (results / "project.json").write_text(json.dumps(configured, ensure_ascii=False, indent=2) + "\n")
    print(f"Test project {project_id}")


def submit(api, project, directory, files, results, manifest):
    login(api)
    project_path = f"/api/projects/{project}"
    api.request("GET", project_path)
    capabilities = api.request("GET", project_path + "/intake/capabilities")
    part_size = capabilities["partSize"]
    if not isinstance(part_size, int) or not 0 < part_size <= 64 * 1024 * 1024:
        raise ValueError("Unexpected part size for the small step-15 corpus")
    receipt = api.request("POST", project_path + "/receipts", {"source": "upload"}, allowed=(200, 201))
    receipt_id = UUID(receipt["receiptId"])
    receipt_path = f"/api/receipts/{receipt_id}"
    (results / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    uploads = []
    for path in files:
        name = path.relative_to(directory).as_posix()
        size = path.stat().st_size
        sha = manifest[name]
        if digest(path) != sha:
            raise ValueError("Local input changed after preflight")
        upload = api.request("POST", receipt_path + "/uploads", {
            "relativePath": name, "size": size, "sha256": sha,
            "mediaType": mimetypes.guess_type(name)[0] or "application/octet-stream",
        }, allowed=(200, 201))
        uploads.append((path, name, sha, UUID(upload["uploadId"])))
    versions = {}
    for path, name, sha, upload_id in uploads:
        upload_path = f"/api/uploads/{upload_id}"
        read_hash = hashlib.sha256()
        with path.open("rb") as stream:
            number = 1
            while chunk := stream.read(part_size):
                read_hash.update(chunk)
                api.request("PUT", f"{upload_path}/parts/{number}", chunk, hashlib.sha256(chunk).hexdigest(),
                            allowed=(200, 201, 204))
                number += 1
        if read_hash.hexdigest() != sha:
            raise ValueError("Local input changed while being uploaded")
        versions[name] = api.request("POST", upload_path + "/complete", {}, allowed=(200, 201, 202))
        (results / "versions.json").write_text(json.dumps(versions, ensure_ascii=False, indent=2) + "\n")
    api.request("POST", receipt_path + "/seal", {}, allowed=(200, 201, 202, 204))
    inventory = api.request("GET", receipt_path + "/inventory")
    (results / "inventory.json").write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n")
    if inventory.get("sealed") is not True:
        raise RuntimeError("Receipt was not sealed")
    originals = {}
    for path, name, expected_sha, _ in uploads:
        version = versions[name]
        document_id = UUID(version["documentId"])
        version_id = UUID(version["versionId"])
        raw = api.request("GET", f"/api/documents/{document_id}/versions/{version_id}/content",
                          expect_original=True)
        sha = hashlib.sha256(raw).hexdigest()
        if sha != expected_sha or len(raw) != path.stat().st_size:
            raise RuntimeError("Retrieved original differs from submitted bytes")
        originals[name] = sha
    (results / "originals.json").write_text(json.dumps(originals, ensure_ascii=False, indent=2) + "\n")
    print(f"Receipt {receipt_id}, declared {len(versions)} originals")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", default="https://127.0.0.1:18443")
    parser.add_argument("--ca-file", type=Path)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--project", type=UUID)
    operation.add_argument("--setup", type=Path, help="Create the synthetic project without submitting originals")
    parser.add_argument("--inputs", type=Path)
    parser.add_argument("--manifest", type=Path, help="Frozen JSON map of input paths to SHA-256 hashes")
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    if args.project:
        if args.inputs is None or args.manifest is None:
            parser.error("--project requires --inputs and --manifest")
        files = list_inputs(args.inputs)
        if args.evidence.resolve().is_relative_to(args.inputs.resolve()):
            raise ValueError("Write evidence outside the submitted directory")
        manifest = load(args.manifest)
        verify_originals(args.inputs, manifest)
    elif args.inputs is not None or args.manifest is not None:
        parser.error("--setup cannot receive --inputs or --manifest")
    os.umask(0o077)
    args.evidence.mkdir(exist_ok=False)
    with (args.evidence / "http.jsonl").open("w", encoding="utf-8") as log:
        api = Intake(args.origin, log, args.ca_file)
        if args.project:
            submit(api, args.project, args.inputs, files, args.evidence, manifest)
        else:
            profile = json.loads(args.setup.read_text(encoding="utf-8"))
            create_project(api, profile, args.evidence)


if __name__ == "__main__":
    main()
