import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from experiments.package_review.package_reading import PackageReading
from experiments.package_review.source_jobs import located_observation


class OrdinarySourceFlowTest(unittest.TestCase):
    def test_two_uploads_and_one_comparison_version_without_manual_source_selection(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            d = Path(directory)
            files = {name: d / name for name in ["order", "shipment"]}
            for k, n in zip(files, [5, 8]):
                files[k].write_text(f"P3 screws   {n}")
            expected = {
                k: hashlib.sha256(v.read_bytes()).hexdigest() for k, v in files.items()
            }
            seen = []

            def source(job, lines):
                seen.append(job["job"])
                fact = located_observation(["P3", [0], "data", lines[0]], lines)
                return [{**fact, "receipt": job["model"] + "/" + job["job"]}]

            service = PackageReading(
                reader=lambda fs, ex: (
                    {k: p.read_text().splitlines() for k, p in fs.items()},
                    ex,
                ),
                models=["A", "B"],
                extract=source,
                compare=lambda case: {"state": "open"},
                gateway_available=lambda: True,
                publish=lambda r, c, i: c,
                workers=2,
            )
            c = service.upload(files, expected, d / "run")
            self.assertEqual(len(c), 1)
            self.assertEqual(len(seen), 4)
            repeat = service.upload(files, expected, d / "run")
            self.assertEqual(c, repeat)
            self.assertEqual(len(seen), 4)
            p = next((d / "run").rglob("source-work.json"))
            self.assertEqual({r["state"] for r in json.loads(p.read_bytes())}, {"read"})

    def test_every_ready_subject_dispatches_under_available_admission(self):
        from experiments.package_review.reading_flow import reading_flow

        with tempfile.TemporaryDirectory() as directory:

            def source(job):
                return [
                    {
                        "label": f"K{i}",
                        "topic": f"k{i}",
                        "source": job["job"],
                        "job": job["job"],
                        "model": "A",
                        "receipt": job["job"] + "/wire",
                        "lines": [i],
                        "unit": job["job"] + "/section",
                        "text": "present",
                        "role": "data",
                    }
                    for i in range(27)
                ]

            cases = reading_flow(
                directory,
                "receipt",
                [{"job": "order"}, {"job": "dispatch"}],
                source,
                lambda _: {"state": "consistent"},
                lambda: True,
                lambda _, c, i: c,
                workers=3,
            )
            self.assertEqual(len(cases), 27)
            self.assertEqual({c["state"] for c in cases}, {"consistent"})

    def test_exact_echo_and_composite_label_rescue_never_rewrites_a_claim(self):
        from experiments.package_review.source_jobs import admit_source_item

        rows = {
            2: "  X7      high pressure valve",
            3: "          steel housing     5 pcs",
        }
        wire = {2: "[2]X7 [10]high pressure valve", 3: "[10]steel housing [28]5 pcs"}
        raw = [
            "X7 high pressure valve steel housing",
            [[2, wire[2]], 3],
            "data",
            "8 pcs",
        ]
        result = admit_source_item(raw, rows, wire)
        self.assertEqual(
            (result["label"], result["text"], result["address_mode"]),
            ("X7", "8 pcs", "exact_echo"),
        )
        self.assertIsNone(
            admit_source_item([raw[0], [[2, "other"]], *raw[2:]], rows, wire)
        )
        self.assertIsNone(
            admit_source_item(["X7 made up title", [2], *raw[2:]], rows, wire)
        )

    def test_address_may_quote_whole_delivered_cells_of_wider_row(self):
        from experiments.package_review.source_jobs import admit_source_item

        original = {4: "  K7   hardware and fixings     12 pcs"}
        wire = {4: "[2]K7 [7]hardware and fixings [32]12 pcs"}

        def read(quote):
            return admit_source_item(
                ["K7", [[4, quote]], "data", "reported amount"], original, wire
            )

        self.assertEqual(
            read("[2]K7 [7]hardware and fixings")["address_mode"], "exact_cells"
        )
        self.assertIsNone(read("[32]12"))
        self.assertIsNone(read("[32]14 pcs"))

    def test_dense_original_cannot_consume_every_early_source_opening(self):
        from experiments.package_review.source_jobs import reading_jobs

        units = {
            "x": ["K7 carrier"] * 20,
            "y": ["K7 carrier"] * 20,
            "z": ["Description only"],
        }
        owners = {k: k for k in units}
        jobs = reading_jobs(units, owners, width=12)
        self.assertEqual({j[1] for j in jobs[:3]}, set(units))
        self.assertEqual(sum(len(j[2]) for j in jobs), 41)


class ReadingCoverageAdapterTest(unittest.TestCase):
    def test_earlier_source_plan_reuses_verified_unit_ownership(self):
        from experiments.package_review.reading_flow import reading_flow

        with tempfile.TemporaryDirectory() as directory:
            revision = "revision"
            folder = Path(directory) / revision
            folder.mkdir()
            job = {"job": "w", "unit": "u", "model": "A", "lines": [0]}

            def old_result(_):
                return {"state": "read", "receipt": "accepted/w", "observations": []}

            # Old revisions could persist an obligation before recording its unit owner.
            reading_flow(
                folder,
                revision,
                [job],
                old_result,
                self.fail,
                lambda: True,
                lambda *_: None,
            )
            (folder / "upload-manifest.json").write_text('{"file":"original"}')
            (folder / "unit-owners.json").write_text('{"u":"original"}')
            (folder / "source-plan.json").write_text(json.dumps([job]))

            reading_flow(
                folder,
                revision,
                [job],
                self.fail,
                self.fail,
                lambda: True,
                lambda *_: None,
            )
            coverage = json.loads((folder / "coverage.json").read_bytes())
            self.assertTrue(coverage["comparison_eligible"])
            self.assertEqual(coverage["by_original"]["original"]["fully_read"], 1)

    def test_empty_read_requires_explicit_response_and_normal_finish(self):
        from experiments.package_review.source_jobs import source_response

        self.assertEqual(source_response("[]", "accepted", "stop")["state"], "read")
        for response, finish in [("", "stop"), ("broken", "stop"), ("[]", "length")]:
            with self.subTest(response=response, finish=finish):
                self.assertEqual(
                    source_response(response, "accepted", finish)["state"], "partial"
                )
