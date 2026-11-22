#!/usr/bin/env python3
"""Exercise private HTTP intake with a small PDF and optional 10 GiB transfer."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256, shake_256
import http.client
import json
import math
import os
from pathlib import Path
import ssl
from threading import Event
from time import monotonic, sleep
from urllib.parse import urlsplit
from uuid import uuid4


ORIGIN = "https://127.0.0.1:18443"
LIMIT = 10 * 1024 ** 3
BASE = Path("/Volumes/ADATA SE920/OrbStack/facade-ai-test-server")
PDF = Path(__file__).resolve().parents[2] / "test/fixtures/input/facade-package.pdf"


class Session:
    def __init__(self, result, password, origin, login="step14_admin"):
        self.log = result
        self.origin = origin
        self.port = urlsplit(origin).port
        self.ssl = ssl.create_default_context(cafile=BASE / "secrets/cert.pem")
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
        if self.origin.startswith("https:"):
            self.connection = http.client.HTTPSConnection("127.0.0.1", self.port, context=self.ssl, timeout=1200)
        else:
            self.connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=1200)

    def request(self, method, path, payload=None, *, statuses=(200, 201), part_sha=None, headers=None,
                parse_json=True):
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
        raw = response.read()
        response_headers = response.headers
        data = json.loads(raw) if parse_json and "application/json" in response_headers.get("Content-Type", "") and raw else raw
        entry = {"method": method, "path": path, "status": response.status, "seconds": monotonic() - start}
        if response.status >= 400 and isinstance(data, dict):
            entry["code"] = data.get("code")
        self.log.write(json.dumps(entry) + "\n")
        self.log.flush()
        if response.status not in statuses:
            raise RuntimeError(f"{method} {path}: HTTP {response.status}, code {entry.get('code')}")
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
        self.request("PUT", path, data, statuses=(200, 201, 204), part_sha=sha256(data).hexdigest())

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

    def publish(self, upload, receipt):
        result = self.request("POST", f"/api/uploads/{upload}/complete", {})[0]
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


def disk_free():
    state = os.statvfs(BASE)
    return state.f_bavail * state.f_frsize


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--large", action="store_true")
    parser.add_argument("--rate-mib", type=int, default=0, help="limit resumed upload to MiB/s")
    parser.add_argument("--origin", default=ORIGIN, choices=(ORIGIN, "http://127.0.0.1:18081"))
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    if args.rate_mib < 0:
        parser.error("--rate-mib must be nonnegative")
    os.umask(0o077)
    args.evidence.mkdir()
    password = os.environ["FACADE_STEP14_PASSWORD"]
    with (args.evidence / "http-a.jsonl").open("w") as log_a, (args.evidence / "http-b.jsonl").open("w") as log_b:
        api = Session(log_a, password, args.origin)
        b = Session(log_b, password, args.origin)
        catalog = api.request("POST", "/api/catalogs", {
            "key": f"step14-{uuid4()}", "name": "Synthetic step 14", "requirements": [],
        })[0]["id"]
        project_a = api.create_project("Synthetic 14 A", catalog)
        project_b = b.create_project("Synthetic 14 B", catalog)
        small, small_hash = small_pdf(b, project_b, "initial.pdf")
        assert sha256(b.request("GET", small)[0]).hexdigest() == small_hash

        capabilities = api.request("GET", f"/api/projects/{project_a}/intake/capabilities")[0]
        assert capabilities["maxReceiptBytes"] == LIMIT
        assert capabilities["diskGuardBytes"] == 40 * 1024 ** 3
        oversized = api.create_receipt(project_a)
        denied = api.declare(oversized, "over-limit.bin", LIMIT + 1, "0" * 64, statuses=(413,))
        assert denied["code"] == "receipt_size_limit"
        summary = {"pdf_sha256": small_hash, "limit_rejection": denied["code"], "overlimit_bytes": LIMIT + 1,
                   "project_a": project_a, "project_b": project_b, "file": small,
                   "protected_bytes": capabilities["diskGuardBytes"], "free_start": disk_free()}
        (args.evidence / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        if not args.large:
            print(json.dumps(summary, indent=2))
            return

        part_size = capabilities["partSize"]
        count = math.ceil(LIMIT / part_size)
        whole = sha256()
        for number in range(1, count + 1):
            whole.update(block(number, min(part_size, LIMIT - (number - 1) * part_size)))
        digest = whole.hexdigest()

        a_rcpt = api.create_receipt(project_a)
        a_upload = api.declare(a_rcpt, "large-a.bin", LIMIT, digest)["uploadId"]
        b_rcpt = b.create_receipt(project_b)
        b_upload = b.declare(b_rcpt, "large-b.bin", LIMIT, digest)["uploadId"]
        # Reopen both transfers via new TCP/TLS connections and resume A only.
        for client, upload in ((api, a_upload), (b, b_upload)):
            client.put_part(upload, 1, block(1, part_size))
            client.interrupt_part(upload, block(2, part_size))
            saved = client.request("GET", f"/api/uploads/{upload}")[0]
            assert [part["number"] for part in saved["parts"]] == [1]
        summary.update({"upload_a": a_upload, "upload_b": b_upload, "part_size": part_size,
                        "large_sha256": digest, "free_after_admission": disk_free()})
        (args.evidence / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")

        started = Event()
        def continue_a():
            start = monotonic()
            remaining_bytes_sent = 0
            for number in range(2, count + 1):
                if number == 2:
                    started.set()
                length = min(part_size, LIMIT - (number - 1) * part_size)
                api.put_part(a_upload, number, block(number, length))
                remaining_bytes_sent += length
                if args.rate_mib:
                    deadline = start + remaining_bytes_sent / (args.rate_mib * 1024 ** 2)
                    sleep(max(0, deadline - monotonic()))
            buffered = monotonic()
            summary["free_after_parts"] = disk_free()
            original = api.publish(a_upload, a_rcpt)
            published = monotonic()
            raw, headers = api.request("GET", original, statuses=(206,), headers={"Range": "bytes=0-31"})
            assert raw == block(1, 32) and headers["Content-Range"] == f"bytes 0-31/{LIMIT}"
            return {"published_bytes": LIMIT, "part_count": count, "remaining_upload_s": buffered - start,
                    "publish_and_seal_s": published - buffered, "free_after_publication": disk_free(),
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
        (args.evidence / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
