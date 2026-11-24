#!/usr/bin/env python3
"""Exercise private HTTP intake with a small PDF and optional 10 GiB transfer."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from hashlib import sha256, shake_256
import http.client
import json
import math
import os
from pathlib import Path
import ssl
import subprocess
import sys
from threading import Event, Lock
from time import monotonic, sleep
from urllib.parse import urlsplit
from uuid import uuid4


ORIGIN = "https://127.0.0.1:18443"
LIMIT = 10 * 1024 ** 3
BASE = Path("/Volumes/ADATA SE920/OrbStack/facade-ai-test-server")
PDF = Path(__file__).resolve().parents[2] / "test/fixtures/input/facade-package.pdf"


class Session:
    def __init__(self, result, password, origin, login, ca_file):
        self.log = result
        self.origin = origin
        self.location = urlsplit(origin)
        self.ssl = ssl.create_default_context(cafile=ca_file)
        self.cookie = None
        self.csrf = None
        self.reconnect()
        login, headers = self.request("POST", "/api/sessions", {
            "login": login, "password": password,
        })
        self.cookie = headers["Set-Cookie"].split(";", 1)[0]
        self.csrf = login["csrfToken"]

    def reconnect(self):
        if hasattr(self, "connection"):
            self.connection.close()
        if self.location.scheme == "https":
            self.connection = http.client.HTTPSConnection(self.location.hostname, self.location.port,
                                                          context=self.ssl, timeout=1200)
        else:
            self.connection = http.client.HTTPConnection(self.location.hostname, self.location.port, timeout=1200)

    def request(self, method, path, payload=None, *, statuses=(200, 201), part_sha=None, headers=None,
                parse_json=True, verify=None):
        hdr = {"Accept": "application/json", **(headers or {})}
        if self.cookie:
            hdr["Cookie"] = self.cookie
        if method not in {"GET", "HEAD"}:
            hdr.update({"Origin": self.origin, "Idempotency-Key": str(uuid4())})
            if self.csrf:
                hdr["X-CSRF-Token"] = self.csrf
        body = None
        if part_sha:
            hdr.update({"Content-Type": "application/octet-stream", "X-Part-SHA256": part_sha})
            body = payload
        elif payload is not None:
            hdr["Content-Type"] = "application/json"
            body = json.dumps(payload).encode()
        start = monotonic()
        self.connection.request(method, path, body=body, headers=hdr)
        response = self.connection.getresponse()
        response_headers = response.headers
        if verify is not None and response.status == 200:
            digest, size = sha256(), 0
            while chunk := response.read(1024 ** 2):
                digest.update(chunk)
                size += len(chunk)
            data = {"size": size, "sha256": digest.hexdigest()}
        else:
            raw = response.read()
            data = json.loads(raw) if parse_json and "application/json" in response_headers.get("Content-Type", "") and raw else raw
        entry = {"method": method, "path": path, "status": response.status, "seconds": monotonic() - start}
        if response.status >= 400 and isinstance(data, dict):
            entry["code"] = data.get("code")
        self.log.write(json.dumps(entry) + "\n")
        self.log.flush()
        if response.status not in statuses:
            raise RuntimeError(f"{method} {path}: HTTP {response.status}, code {entry.get('code')}")
        if verify is not None and data != verify:
            raise RuntimeError(f"Downloaded original differs: expected {verify}, got {data}")
        return data, response_headers

    def create_project(self, name, catalog):
        return self.request("POST", "/api/projects", {"name": name, "catalogVersionId": catalog})[0]["id"]

    def create_receipt(self, project):
        receipt = self.request("POST", f"/api/projects/{project}/receipts", {"source": "upload"})[0]["receiptId"]
        return f"/api/receipts/{receipt}"

    def declare(self, receipt, name, size, digest, statuses=(201,)):
        return self.request("POST", f"{receipt}/uploads", {
            "relativePath": name, "size": size, "sha256": digest,
            "mediaType": "application/pdf" if name.endswith(".pdf") else "application/octet-stream",
        }, statuses=statuses)[0]

    def put_part(self, upload, number, data):
        path = f"/api/uploads/{upload}/parts/{number}"
        digest = sha256(data).hexdigest()
        for _ in range(10):
            answer, _ = self.request("PUT", path, data, statuses=(200, 409), part_sha=digest)
            if answer.get("code") != "upload_busy":
                assert answer["number"] == number and answer["sha256"] == digest and answer["length"] == len(data)
                return
            sleep(0.2)
        raise RuntimeError(f"Upload still busy after reopening: {path}")

    def interrupt_part(self, upload, data):
        path = f"/api/uploads/{upload}/parts/2"
        self.connection.putrequest("PUT", path)
        for key, value in {
            "Cookie": self.cookie, "Origin": self.origin, "X-CSRF-Token": self.csrf,
            "Content-Type": "application/octet-stream", "Content-Length": str(len(data)),
            "X-Part-SHA256": sha256(data).hexdigest(),
        }.items():
            self.connection.putheader(key, value)
        started = monotonic()
        self.connection.endheaders()
        self.connection.send(data[:min(len(data) // 2, 1024 ** 2)])
        self.reconnect()
        self.log.write(json.dumps({"method": "PUT", "path": path, "status": "client_interrupted",
                                   "seconds": monotonic() - started}) + "\n")
        self.log.flush()

    def complete(self, upload):
        return self.request("POST", f"/api/uploads/{upload}/complete", {})[0]

    def publish(self, upload, receipt):
        result = self.complete(upload)
        self.request("POST", f"{receipt}/seal", {})
        self.request("GET", f"{receipt}/inventory")
        return f"/api/documents/{result['documentId']}/versions/{result['versionId']}/content"


def small_pdf(api, project, name):
    data = PDF.read_bytes()
    receipt = api.create_receipt(project)
    upload = api.declare(receipt, name, len(data), sha256(data).hexdigest())["uploadId"]
    api.put_part(upload, 1, data)
    return api.publish(upload, receipt), sha256(data).hexdigest()


def block(number, length):
    return shake_256(f"facade-ai-step14-v1/{number}".encode()).digest(length)


def disk_free(path):
    state = os.statvfs(path)
    return state.f_bavail * state.f_frsize


def allocated(path):
    total = 0
    for root, _, files in os.walk(path):
        for name in files:
            try:
                total += (Path(root) / name).lstat().st_blocks * 512
            except FileNotFoundError:
                # Publication and expiry can remove a file between walk and stat.
                continue
    return total


@contextmanager
def sample_disk(disk_path, staging, scratch, evidence):
    stop = Event()
    paths = ([staging] if staging else []) + scratch
    start = monotonic()
    peaks = {"free_min": disk_free(disk_path), "allocated_max": [0] * len(paths), "concurrent_allocated_max": 0}
    with (evidence / "disk.jsonl").open("w") as log:
        def sample(phase):
            free = disk_free(disk_path)
            sizes = [allocated(path) for path in paths]
            peaks["free_min"] = min(peaks["free_min"], free)
            peaks["allocated_max"] = [max(old, new) for old, new in zip(peaks["allocated_max"], sizes)]
            peaks["concurrent_allocated_max"] = max(peaks["concurrent_allocated_max"], sum(sizes))
            log.write(json.dumps({"seconds": monotonic() - start, "phase": phase,
                                  "free_bytes": free, "allocated_bytes": sizes}) + "\n")
            log.flush()

        lock = Lock()
        def checkpoint(phase):
            with lock:
                sample(phase)

        def poll():
            while not stop.wait(0.5):
                checkpoint("periodic")

        checkpoint("baseline")
        with ThreadPoolExecutor(max_workers=1) as pool:
            sampler = pool.submit(poll)
            try:
                yield checkpoint
            finally:
                stop.set()
                sampler.result()
                checkpoint("end")
                peaks.update({"disk_path": str(disk_path), "directory_order": [str(path) for path in paths]})
                (evidence / "disk-summary.json").write_text(json.dumps(peaks, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    size = parser.add_mutually_exclusive_group()
    size.add_argument("--large", action="store_true")
    size.add_argument("--transfer-mib", type=int, help="run the same transfer sequence on a smaller object")
    size.add_argument("--observe", action="store_true",
                      help="observe disk while running a separate scenario; pass its command last")
    parser.add_argument("--rate-mib", type=int, default=0, help="limit resumed upload to MiB/s")
    parser.add_argument("--origin", default=ORIGIN)
    parser.add_argument("--ca-file", type=Path, help="CA for the application's HTTPS endpoint")
    parser.add_argument("--disk-path", type=Path, default=BASE, help="path on the application's staging filesystem")
    parser.add_argument("--staging-dir", type=Path, help="dedicated application intake-parts directory")
    parser.add_argument("--scratch-dir", type=Path, action="append", default=[],
                        help="additional dedicated temporary directory, repeat for each disjoint root")
    parser.add_argument("--evidence", type=Path, required=True)
    options = sys.argv[1:]
    command = []
    if "--observe" in options:
        end = options.index("--observe") + 1
        options, command = options[:end], options[end:]
    args = parser.parse_args(options)
    if args.rate_mib < 0:
        parser.error("--rate-mib must be nonnegative")
    if args.transfer_mib is not None and not 1 <= args.transfer_mib < 10 * 1024:
        parser.error("--transfer-mib must be in 1..10239")
    origin = urlsplit(args.origin)
    if (not origin.hostname or origin.username or origin.password or origin.path or origin.query or origin.fragment
            or (origin.scheme != "https" and not (origin.scheme == "http" and origin.hostname == "127.0.0.1"))):
        parser.error("--origin must be an HTTPS origin or loopback HTTP")
    roots = [path.resolve() for path in [args.staging_dir, *args.scratch_dir] if path is not None]
    for index, root in enumerate(roots):
        if any(root == other or root in other.parents or other in root.parents for other in roots[:index]):
            parser.error("staging and scratch roots must be disjoint")
    if args.staging_dir and args.staging_dir.name != "intake-parts":
        parser.error("--staging-dir must point to intake-parts for the dedicated runtime")
    if args.staging_dir and args.staging_dir.parent.stat().st_dev != args.disk_path.stat().st_dev:
        parser.error("--disk-path must be on the same filesystem as staging")
    if args.observe and not command:
        parser.error("--observe requires a command")
    os.umask(0o077)
    args.evidence.mkdir()
    with sample_disk(args.disk_path, args.staging_dir, args.scratch_dir, args.evidence) as checkpoint:
        if args.observe:
            subprocess.run(command, check=True)
        else:
            exercise(args, checkpoint)


def exercise(args, checkpoint):
    password = os.environ["FACADE_STEP14_PASSWORD"]
    login = os.environ.get("FACADE_STEP14_LOGIN", "step14_admin")
    ca_file = args.ca_file or (BASE / "secrets/cert.pem" if args.origin == ORIGIN else None)
    clients = (password, args.origin, login, ca_file)
    with (args.evidence / "http-a.jsonl").open("w") as log_a, (args.evidence / "http-b.jsonl").open("w") as log_b:
        api = Session(log_a, *clients)
        b = Session(log_b, *clients)
        catalog = api.request("POST", "/api/catalogs", {
            "key": f"step14-{uuid4()}", "name": "Synthetic step 14", "requirements": [],
        })[0]["id"]
        project_a = api.create_project("Synthetic 14 A", catalog)
        project_b = b.create_project("Synthetic 14 B", catalog)
        small, small_hash = small_pdf(b, project_b, "initial.pdf")
        assert sha256(b.request("GET", small)[0]).hexdigest() == small_hash

        capabilities = api.request("GET", f"/api/projects/{project_a}/intake/capabilities")[0]
        assert capabilities["maxReceiptBytes"] == LIMIT
        oversized = api.create_receipt(project_a)
        denied = api.declare(oversized, "over-limit.bin", LIMIT + 1, "0" * 64, statuses=(413,))
        assert denied["code"] == "receipt_size_limit"
        summary = {"pdf_sha256": small_hash, "limit_rejection": denied["code"], "overlimit_bytes": LIMIT + 1,
                   "project_a": project_a, "project_b": project_b, "file": small,
                   "protected_bytes": capabilities["diskGuardBytes"], "free_start": disk_free(args.disk_path)}
        (args.evidence / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        if not (args.large or args.transfer_mib):
            print(json.dumps(summary, indent=2))
            return

        part_size = capabilities["partSize"]
        size = LIMIT if args.large else args.transfer_mib * 1024 ** 2
        count = math.ceil(size / part_size)
        if count < 2:
            raise ValueError("An interrupted/resumed transfer needs at least two parts")
        def length(number):
            return min(part_size, size - (number - 1) * part_size)

        whole = sha256()
        for number in range(1, count + 1):
            whole.update(block(number, length(number)))
        digest = whole.hexdigest()

        a_rcpt = api.create_receipt(project_a)
        a_upload = api.declare(a_rcpt, "large-a.bin", size, digest)["uploadId"]
        remaining = LIMIT - size + 1
        assert api.declare(a_rcpt, "cumulative-limit.bin", remaining, "0" * 64,
                           statuses=(413,))["code"] == "receipt_size_limit"
        b_rcpt = b.create_receipt(project_b)
        b_upload = b.declare(b_rcpt, "large-b.bin", size, digest)["uploadId"]
        for client, upload in ((api, a_upload), (b, b_upload)):
            client.put_part(upload, 1, block(1, length(1)))
            client.interrupt_part(upload, block(2, length(2)))
        # Use fresh authenticated sessions to establish that the map is server-owned.
        api.connection.close()
        b.connection.close()
        api = Session(log_a, *clients)
        b = Session(log_b, *clients)
        for client, upload in ((api, a_upload), (b, b_upload)):
            saved = client.request("GET", f"/api/uploads/{upload}")[0]
            assert [part["number"] for part in saved["parts"]] == [1]
            assert saved["confirmedBytes"] == length(1)
        checkpoint("after_interruption")
        if args.staging_dir and allocated(args.staging_dir / a_upload) == 0:
            raise RuntimeError("Confirmed upload has no allocated parts in the selected staging directory")
        summary.update({"upload_a": a_upload, "upload_b": b_upload, "part_size": part_size,
                        "large_sha256": digest, "free_after_admission": disk_free(args.disk_path),
                        "cumulative_limit_rejection_bytes": remaining})
        (args.evidence / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")

        started = Event()
        def continue_a():
            start = monotonic()
            remaining_bytes_sent = 0
            for number in range(2, count + 1):
                if number == 2:
                    started.set()
                api.put_part(a_upload, number, block(number, length(number)))
                remaining_bytes_sent += length(number)
                if args.rate_mib:
                    deadline = start + remaining_bytes_sent / (args.rate_mib * 1024 ** 2)
                    sleep(max(0, deadline - monotonic()))
            buffered = monotonic()
            checkpoint("all_parts_confirmed")
            summary["free_after_parts"] = disk_free(args.disk_path)
            publication = api.complete(a_upload)
            published = monotonic()
            free_at_publication = disk_free(args.disk_path)
            checkpoint("published")
            api.reconnect()
            assert api.complete(a_upload) == publication
            api.request("POST", f"{a_rcpt}/seal", {})
            original = f"/api/documents/{publication['documentId']}/versions/{publication['versionId']}/content"
            raw, headers = api.request("GET", original, statuses=(206,), headers={"Range": "bytes=0-31"})
            assert raw == block(1, 32) and headers["Content-Range"] == f"bytes 0-31/{size}"
            assert api.request("HEAD", original)[1]["Content-Length"] == str(size)
            verified = api.request("GET", original, verify={"size": size, "sha256": digest})[0]
            checkpoint("download_verified")
            return {"published_bytes": size, "part_count": count, "remaining_upload_s": buffered - start,
                    "publish_s": published - buffered, "verified_download": verified,
                    "free_after_publication": free_at_publication,
                    "large_document": original}

        with ThreadPoolExecutor(max_workers=1) as pool:
            moving = pool.submit(continue_a)
            assert started.wait(10)
            sample = monotonic()
            assert b.request("GET", small, statuses=(206,), headers={"Range": "bytes=0-4"})[0] == b"%PDF-"
            independent, _ = small_pdf(b, project_b, "independent.pdf")
            assert b.request("HEAD", independent)[1]["Content-Length"] == str(PDF.stat().st_size)
            summary["b_http_read_and_receive_s"] = monotonic() - sample
            summary["b_completed_while_a_active"] = not moving.done()
            summary.update(moving.result())
        (args.evidence / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        b.reconnect()
        saved = b.request("GET", f"/api/uploads/{b_upload}")[0]
        assert saved["status"] == "uploading" and [part["number"] for part in saved["parts"]] == [1]
        summary.update({"b_retained_part_bytes": saved["parts"][0]["length"], "b_expires_at": saved["expiresAt"],
                        "upload_rate_limit_mib_s": args.rate_mib})
        assert b.request("POST", f"/api/uploads/{b_upload}/cancel", {})[0]["status"] == "cancelled"
        (args.evidence / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
