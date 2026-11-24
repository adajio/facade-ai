"""Confirm the small-corpus uploader uses the public contract end to end."""

import hashlib
import io
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

from intake import Intake, list_inputs, submit


PROJECT = "10000000-0000-0000-0000-000000000001"
RECEIPT = "10000000-0000-0000-0000-000000000002"
UPLOAD = "10000000-0000-0000-0000-000000000003"
DOCUMENT = "10000000-0000-0000-0000-000000000004"
VERSION = "10000000-0000-0000-0000-000000000005"
INPUT = b"original bytes"
PUBLIC_TOKEN = "local-fixture-csrf"


class UploaderControls(unittest.TestCase):
    def test_upload_parts_seal_and_authorized_original_round_trip(self):
        calls = []
        parts = bytearray()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def send(self, code, data=None, headers=None):
                self.send_response(code)
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                if isinstance(data, bytes):
                    self.wfile.write(data)
                elif data is not None:
                    self.wfile.write(json.dumps(data).encode())

            def body(self):
                return self.rfile.read(int(self.headers.get("Content-Length", 0)))

            def do_GET(self):
                calls.append(("GET", self.path))
                if self.path == "/readyz":
                    self.send(200, {"ok": True})
                elif self.headers.get("Cookie") != "facade_session=sample":
                    self.send(401)
                elif self.path == f"/api/projects/{PROJECT}/intake/capabilities":
                    self.send(200, {"partSize": 4})
                elif self.path == f"/api/receipts/{RECEIPT}/inventory":
                    self.send(200, {"sealed": True})
                elif self.path == f"/api/documents/{DOCUMENT}/versions/{VERSION}/content":
                    self.send(200, bytes(parts), {"Cache-Control": "no-store"})
                elif self.path == f"/api/projects/{PROJECT}":
                    self.send(200, {"id": PROJECT})
                else:
                    self.send(404)

            def do_POST(self):
                calls.append(("POST", self.path))
                body = json.loads(self.body())
                if self.path == "/api/sessions":
                    if body != {"login": "fake", "password": "local-passphrase"}:
                        self.send(401)
                        return
                    self.send(200, {"csrfToken": PUBLIC_TOKEN},
                              {"Set-Cookie": "facade_session=sample; Path=/; HttpOnly"})
                    return
                if self.headers.get("X-CSRF-Token") != PUBLIC_TOKEN or not self.headers.get("Idempotency-Key"):
                    self.send(403)
                elif self.path == f"/api/projects/{PROJECT}/receipts":
                    self.send(201, {"receiptId": RECEIPT})
                elif self.path == f"/api/receipts/{RECEIPT}/uploads":
                    if body["relativePath"] != "folder/source.txt" or "scopeIds" in body:
                        self.send(422)
                        return
                    self.send(201, {"uploadId": UPLOAD})
                elif self.path == f"/api/uploads/{UPLOAD}/complete":
                    self.send(200, {"documentId": DOCUMENT, "versionId": VERSION})
                elif self.path == f"/api/receipts/{RECEIPT}/seal":
                    self.send(204)
                else:
                    self.send(404)

            def do_PUT(self):
                calls.append(("PUT", self.path))
                body = self.body()
                if (not self.path.startswith(f"/api/uploads/{UPLOAD}/parts/")
                        or self.headers.get("X-Part-SHA256") != hashlib.sha256(body).hexdigest()):
                    self.send(422)
                    return
                parts.extend(body)
                self.send(204)

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            inputs = root / "inputs"
            (inputs / "folder").mkdir(parents=True)
            (inputs / "folder/source.txt").write_bytes(INPUT)
            result = root / "evidence"
            result.mkdir()
            journal = io.StringIO()
            origin = f"http://127.0.0.1:{server.server_port}"
            manifest = {"folder/source.txt": hashlib.sha256(INPUT).hexdigest()}
            with patch.dict("os.environ", {
                "FACADE_ACCEPTANCE_LOGIN": "fake", "FACADE_ACCEPTANCE_PASSWORD": "local-passphrase",
            }), patch("builtins.print"):
                submit(Intake(origin, journal), UUID(PROJECT), inputs, list_inputs(inputs), result, manifest)
            retrieved = json.loads((result / "originals.json").read_bytes())
            self.assertEqual(retrieved, manifest)
            self.assertEqual(bytes(parts), INPUT)
            self.assertEqual(sum(method == "PUT" for method, _ in calls), 4)
            self.assertNotIn(PUBLIC_TOKEN, journal.getvalue())
            self.assertNotIn("local-passphrase", journal.getvalue())


if __name__ == "__main__":
    unittest.main()
