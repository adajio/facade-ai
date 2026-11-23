import tempfile
import unittest
from pathlib import Path
import json

from experiments.package_review.comparison_reader import read_assignment
from experiments.package_review.research import digest


class ComparisonReaderTest(unittest.TestCase):
    def test_foreign_response_and_truncated_result_survive_as_separate_outcomes(self):
        parts = [{"type": "text", "text": "real material"}]
        views = {"a": [2], "b": [5]}
        def ask(model, material, directory):
            return {"material_digest": digest(material) if model == "one" else "foreign",
                    "receipt": model, "finish_reason": "length",
                    "content": '{"decision":"compared","sources":[{"ref":"a","lines":[2],"reading":"x"},'
                               '{"ref":"b","lines":[5],"reading":"y"}],"entries":[{"'}
        with tempfile.TemporaryDirectory() as root:
            status, receipts, complete = read_assignment(
                {"units": list(views), "task_id": "t"}, {}, readers=["one", "two"], evidence_dir=root,
                deliver=lambda task, units: (parts, views), ask=ask)
            self.assertFalse(complete)
            self.assertEqual(status, "partial")
            self.assertEqual([r["reader"] for r in receipts], ["one", "one"])
            result = json.loads(next(Path(root).rglob("addressed.json")).read_bytes())["results"]
            self.assertTrue(result["one"]["comparison_requested"])
            self.assertIn("error", result["two"])

    def test_each_reader_can_expand_a_cut_view_and_refer_to_returned_material(self):
        refs = ["x","y"]
        base = [{"type":"text","text":"cropped"}]
        opened = []
        def ask(reader, material, directory):
            if material == base:
                payload = {"calls":[{"op":"view","ref":"x","rect":[0,0,1,1]}]}
            else:
                payload = {"decision":"compared", "sources":[
                    {"ref":"x","lines":[9],"reading":"whole figure"},
                    {"ref":"y","lines":[2],"reading":"corresponding item"}]}
            return {"receipt":str(directory), "material_digest":digest(material),
                    "content":json.dumps(payload), "finish_reason":"stop"}
        def open_more(reader, call, units):
            opened.append((reader,call["ref"]))
            return [{"type":"text","text":"whole"}], {"x":[9]}
        with tempfile.TemporaryDirectory() as root:
            out, anchors, closed = read_assignment(
                {"units": refs, "task_id":"expand"}, {}, readers=["one","two"], evidence_dir=root,
                deliver=lambda *_: (base, {"x":[1],"y":[2]}), ask=ask, open_more=open_more)
            self.assertCountEqual(opened, [("one","x"),("two","x")])
            self.assertEqual((out, len(anchors), closed), ("compared",4,True))

    def test_last_request_resumes_on_a_new_lease_without_rebilling_first_turn(self):
        parts = [{"type":"text","text":"first"}]
        calls = []
        def ask(model, material, directory):
            calls.append((model,len(material)))
            payload = ({"calls":[{"op":"read","ref":"x","start":8}]} if material == parts
                       else {"decision":"different_scope","sources":[
                           {"ref":"x","lines":[8],"reading":"X"},{"ref":"y","lines":[0],"reading":"Y"}]})
            return {"receipt":str(directory),"material_digest":digest(material),"content":json.dumps(payload)}
        with tempfile.TemporaryDirectory() as root:
            opts = {"readers":["a","b"],"evidence_dir":root,
                    "deliver":lambda *_:(parts,{"x":[0],"y":[0]}),"ask":ask,
                    "open_more":lambda *_:([{"type":"text","text":"next"}],{"x":[8]}),
                    "turns_per_lease":1}
            task={"units":["x","y"],"task_id":"resume"}
            self.assertFalse(read_assignment(task,{},**opts)[2])
            self.assertTrue(read_assignment(task,{},**opts)[2])
            self.assertCountEqual(calls,[("a",1),("b",1),("a",3),("b",3)])

    def test_truncation_prompts_targeted_continuation_using_the_same_unchanged_sources(self):
        parts = [{"type":"text","text":"records"}]
        def ask(model, material, path):
            text = ('{"sources":[{"ref":"a","lines":[0],"reading":"one"}],"entries":[{'
                    if material == parts else
                    '{"decision":"compared","sources":[{"ref":"a","lines":[0],"reading":"one"},'
                    '{"ref":"b","lines":[0],"reading":"two"}]}')
            return {"receipt":str(path),"material_digest":digest(material),"content":text,
                    "finish_reason":"length" if material == parts else "stop"}
        with tempfile.TemporaryDirectory() as root:
            outcome = read_assignment({"units":["a","b"],"task_id":"partial"}, {},
                                      readers=["one","two"], evidence_dir=root, ask=ask,
                                      deliver=lambda *_:(parts,{"a":[0],"b":[0]}))
            self.assertTrue(outcome[2])
            data = json.loads(next(Path(root).rglob("addressed.json")).read_bytes())
            self.assertEqual(len(data["results"]["one"]["prior_partial_readings"]),1)
