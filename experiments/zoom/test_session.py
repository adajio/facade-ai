"""Offline boundary tests; no keys or provider calls."""

import tempfile
from pathlib import Path
import unittest

from experiments.zoom.session import (AdmissionDeferred, KnownProviderFailure,
    certify_admission_deferred, record_response, run_session)


def response(*ids, content=None, finish=None):
    message = {"role": "assistant", "content": content, "reasoning_details": [{"text": "retained"}]}
    if ids:
        message["tool_calls"] = [{"id": i, "type": "function", "function": {
            "name": "view_region", "arguments": '{"rect":[0,0,1,1]}'}} for i in ids]
    return {"choices": [{"message": message, "finish_reason": finish or ("tool_calls" if ids else "stop")}]}


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.initial = [{"role": "user", "content": "Read the selected field"}]
        self.options = {"model": "synthetic/model", "tools": [], "tool_choice": "auto"}
        self.tool_calls = []

    def tool(self, call, directory):
        self.tool_calls.append(call["id"])
        (directory / "crop.png").write_bytes(b"synthetic pixels")
        return [{"role": "tool", "tool_call_id": call["id"], "content": "ready"},
                {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,eA=="}}]}]

    def run_loop(self, send, **kwargs):
        max_tool_rounds = kwargs.pop("max_tool_rounds", 1)
        return run_session(self.root, initial_messages=self.initial, request_options=self.options,
                           send=send, execute_tool=self.tool, max_tool_rounds=max_tool_rounds, **kwargs)

    def test_last_round_delivers_all_results_before_synthesis_and_replay_is_free(self):
        requests = []

        def send(request, directory):
            requests.append(request)
            return response("a", "b") if len(requests) == 1 else response(content="42 mm")

        result = self.run_loop(send)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[-1]["tool_choice"], "none")
        self.assertEqual([m.get("tool_call_id") for m in requests[-1]["messages"] if m["role"] == "tool"], ["a", "b"])
        self.assertEqual([m["role"] for m in requests[-1]["messages"]], ["user", "assistant", "tool", "tool", "user", "user"])
        self.assertEqual(requests[-1]["messages"][1]["reasoning_details"], [{"text": "retained"}])
        self.assertEqual(result["tool_results_with_response"], ["a", "b"])
        replay = self.run_loop(lambda *_: self.fail("Paid replay"))
        self.assertEqual(replay["status"], "completed")
        self.assertEqual(replay["external_calls_started_this_run"], 0)
        self.assertEqual(self.tool_calls, ["a", "b"])

    def test_unknown_external_outcome_is_held_across_restart(self):
        count = 0

        def send(*_):
            nonlocal count
            count += 1
            raise TimeoutError()

        self.assertEqual(self.run_loop(send)["status"], "outcome_unknown")
        self.assertEqual(self.run_loop(send)["status"], "outcome_unknown")
        self.assertEqual(count, 1)

    def test_saved_response_survives_process_stop_before_return(self):
        def send(request, directory):
            record_response(directory, response("a"))
            raise KeyboardInterrupt()

        with self.assertRaises(KeyboardInterrupt):
            self.run_loop(send)
        resumed = []

        def resume(request, directory):
            resumed.append(request)
            return response(content="42 mm")

        result = self.run_loop(resume)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(resumed), 1)
        self.assertEqual(resumed[0]["tool_choice"], "none")
        self.assertEqual(result["replayed_responses"], 1)

    def test_ready_crop_is_not_reported_as_received_answer(self):
        count = 0

        def send(request, directory):
            nonlocal count
            count += 1
            if count == 1:
                return response("a")
            raise TimeoutError()

        result = self.run_loop(send)
        self.assertFalse(result["final_answer_received"])
        self.assertEqual(len(result["prepared_tools"]), 1)
        self.assertEqual(result["tool_results_with_response"], [])
        replay = self.run_loop(lambda *_: self.fail("Unknown call resent"))
        self.assertEqual(replay["status"], "outcome_unknown")
        self.assertEqual(self.tool_calls, ["a"])

    def test_calls_after_forced_synthesis_are_preserved_unexecuted(self):
        replies = iter([response("a"), response("later")])
        result = self.run_loop(lambda *_: next(replies))
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(result["unexecuted_tool_calls"][0]["id"], "later")
        self.assertEqual(self.tool_calls, ["a"])
        self.assertFalse(result["final_answer_received"])

    def test_reader_failure_retries_local_work_without_repaying(self):
        original_tool = self.tool
        self.tool = lambda *_: (_ for _ in ()).throw(ValueError("reader failed"))
        first = self.run_loop(lambda *_: response("a"))
        self.assertEqual(first["status"], "tool_failed")
        self.tool = original_tool
        requests = []

        def send(request, directory):
            requests.append(request)
            return response(content="42 mm")

        second = self.run_loop(send)
        self.assertEqual(second["status"], "completed")
        self.assertEqual(len(requests), 1)
        self.assertEqual(second["replayed_responses"], 1)

    def test_known_failure_not_resent_and_changed_input_rejected(self):
        def send(*_):
            raise KnownProviderFailure("HTTP rejection")

        self.assertEqual(self.run_loop(send)["status"], "provider_failed")
        self.assertEqual(self.run_loop(lambda *_: self.fail("Failure resent"))["status"], "provider_failed")
        self.options["model"] = "different/model"
        with self.assertRaisesRegex(ValueError, "evidence differs"):
            self.run_loop(lambda *_: self.fail("Changed input sent"))

    def test_truncated_text_is_not_a_final_answer(self):
        result = self.run_loop(lambda *_: response(content="42", finish="length"))
        self.assertEqual(result["status"], "incomplete")
        self.assertFalse(result["final_answer_received"])

    def test_reader_binding_is_immutable_and_required_on_resume(self):
        binding = {"base_sha256": "base", "supply_sha256": "supply", "reader_revision": 1}
        result = self.run_loop(lambda *_: response(content="42 mm"), reader_binding=binding)
        self.assertEqual(result["status"], "completed")
        replay = self.run_loop(lambda *_: self.fail("Paid replay"), reader_binding=binding)
        self.assertEqual(replay["external_calls_started_this_run"], 0)
        with self.assertRaisesRegex(ValueError, "evidence differs"):
            self.run_loop(lambda *_: self.fail("Changed reader sent"),
                          reader_binding={**binding, "supply_sha256": "changed"})
        with self.assertRaisesRegex(ValueError, "required to resume"):
            self.run_loop(lambda *_: self.fail("Unbound resume sent"))

    def test_binding_old_session_preserves_manifest(self):
        self.run_loop(lambda *_: response(content="42 mm"))
        manifest_before = (self.root / "manifest.json").read_bytes()
        self.run_loop(lambda *_: self.fail("Paid replay"), reader_binding={"externally_audited": True})
        self.assertEqual((self.root / "manifest.json").read_bytes(), manifest_before)

    def test_deferred_admission_resumes_only_next_run_and_keeps_prior_tools(self):
        count = 0

        def send(request, directory):
            nonlocal count
            count += 1
            if count == 1:
                return response("a")
            raise AdmissionDeferred("Local budget gate: no dispatch")

        first = self.run_loop(send)
        self.assertEqual(first["status"], "admission_deferred")
        self.assertEqual(count, 2)  # No admission retry inside this run.
        self.assertEqual(first["external_calls_started_this_run"], 1)
        self.assertEqual(first["tool_results_with_response"], [])
        request_bytes = (self.root / "attempts/0002/request.json").read_bytes()
        next_requests = []

        def resume(request, directory):
            next_requests.append(request)
            return response(content="42 mm")

        result = self.run_loop(resume)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(next_requests), 1)
        self.assertEqual(self.tool_calls, ["a"])
        self.assertEqual((self.root / "attempts/0002/request.json").read_bytes(), request_bytes)
        self.assertEqual(result["attempts"][-1]["dispatch_count"], 2)
        self.assertEqual(len(result["attempts"][-1]["admission_deferrals"]), 1)
        self.assertTrue((self.root / "attempts/0002/dispatches/0001/deferred.json").exists())

    def test_unknown_after_deferred_readmission_is_never_retried(self):
        def defer(*_):
            raise AdmissionDeferred("No external call")

        self.assertEqual(self.run_loop(defer)["status"], "admission_deferred")
        self.assertEqual(self.run_loop(defer)["status"], "admission_deferred")

        def unknown(*_):
            raise TimeoutError()

        self.assertEqual(self.run_loop(unknown)["status"], "outcome_unknown")
        result = self.run_loop(lambda *_: self.fail("Unknown outcome resent"))
        self.assertEqual(result["status"], "outcome_unknown")
        self.assertEqual(result["attempts"][0]["dispatch_count"], 3)
        self.assertEqual(len(result["attempts"][0]["admission_deferrals"]), 2)

    def test_opt_in_recovers_saved_empty_truncation_without_resending_prior_requests(self):
        replies = iter([response("a"), response(content=None, finish="length")])
        original = self.run_loop(lambda *_: next(replies), max_tool_rounds=4)
        self.assertEqual(original["status"], "incomplete")
        before = {p: p.read_bytes() for p in self.root.glob("attempts/*/*.json")}
        manifest = (self.root / "manifest.json").read_bytes()
        requests = []

        def resume(request, directory):
            requests.append(request)
            return response(content="42 mm")

        result = self.run_loop(resume, max_tool_rounds=4, synthesis_max_tokens=4800)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(requests), 1)
        self.assertEqual(result["replayed_responses"], 2)
        self.assertEqual(requests[0]["tool_choice"], "none")
        self.assertEqual(requests[0]["max_tokens"], 4800)
        self.assertEqual(self.tool_calls, ["a"])
        self.assertEqual(requests[0]["messages"][:-1], original["messages"][:-1])
        self.assertEqual((self.root / "manifest.json").read_bytes(), manifest)
        for path, data in before.items():
            self.assertEqual(path.read_bytes(), data)
        replay = self.run_loop(lambda *_: self.fail("Paid replay"), max_tool_rounds=4,
                               synthesis_max_tokens=4800)
        self.assertEqual(replay["status"], "completed")
        with self.assertRaisesRegex(ValueError, "evidence differs"):
            self.run_loop(lambda *_: self.fail("Modified synthesis sent"), max_tool_rounds=4,
                          synthesis_max_tokens=9600)

    def test_recovery_synthesis_truncation_stays_incomplete(self):
        replies = iter([response("a"), response(content="", finish="length"),
                        response(content=None, finish="length")])
        result = self.run_loop(lambda *_: next(replies), max_tool_rounds=4, synthesis_max_tokens=4800)
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(result["attempt_count"], 3)
        self.assertEqual(result["attempts"][-1]["phase"], "synthesis")

    def test_unknown_recovery_synthesis_is_not_resent(self):
        replies = iter([response("a"), response(content="", finish="length")])

        def send(*_):
            try:
                return next(replies)
            except StopIteration:
                raise TimeoutError()

        result = self.run_loop(send, max_tool_rounds=4, synthesis_max_tokens=4800)
        self.assertEqual(result["status"], "outcome_unknown")
        self.assertEqual(self.run_loop(lambda *_: self.fail("Unknown synthesis resent"),
                         max_tool_rounds=4, synthesis_max_tokens=4800)["status"], "outcome_unknown")

    def test_empty_truncation_before_any_tool_result_is_not_recovered(self):
        result = self.run_loop(lambda *_: response(content="", finish="length"),
                               max_tool_rounds=4, synthesis_max_tokens=4800)
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(result["attempt_count"], 1)

    def test_nonempty_truncated_response_is_not_recovered(self):
        replies = iter([response("a"), response(content="partial answer", finish="length")])
        result = self.run_loop(lambda *_: next(replies), max_tool_rounds=4, synthesis_max_tokens=4800)
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(result["attempt_count"], 2)

    def test_recovery_opt_in_preserves_previous_ordinary_drain_request(self):
        self.options["max_tokens"] = 2400
        replies = iter([response("a"), response(content="42 mm")])
        self.assertEqual(self.run_loop(lambda *_: next(replies))["status"], "completed")
        path = self.root / "attempts/0002/request.json"
        before = path.read_bytes()
        result = self.run_loop(lambda *_: self.fail("Ordinary drain resent"), synthesis_max_tokens=4800)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(path.read_bytes(), before)

    def test_transport_certificate_cannot_reclassify_unknown_attempt(self):
        def unknown(*_):
            raise TimeoutError()

        self.run_loop(unknown)
        with self.assertRaisesRegex(ValueError, "dispatch/response"):
            certify_admission_deferred(self.root, 1,
                verify_transport=lambda *_: self.fail("Unknown attempt sent to verifier"))

    def test_transport_certificate_requires_positive_non_send_receipt(self):
        def known(*_):
            raise KnownProviderFailure("Local capacity refused before dispatch")

        self.run_loop(known)
        (self.root / "attempts/0001/dispatches").rename(self.root / "previous-layout")
        with self.assertRaisesRegex(ValueError, "positively confirm"):
            certify_admission_deferred(self.root, 1,
                verify_transport=lambda *_: {"externally_sent": None})
        self.assertFalse((self.root / "attempts/0001/admission-certificate.json").exists())



if __name__ == "__main__":
    unittest.main()
