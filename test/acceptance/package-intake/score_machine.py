"""Compare the frozen managed run to the private originals and independent addresses."""

import argparse
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
import re

from audit_corpus import anchors, read_json


def normalize(text):
    return " ".join(text.split())


def located(address, expected):
    locator = dict(address.get("locator") or {})
    page = re.fullmatch(r"(?:pdf:)?page:(\d+)", address.get("unitId", ""))
    if page:
        locator.setdefault("page", int(page[1]))
    if "page" in address:
        locator.setdefault("page", address["page"])
    return all(locator.get(key) == value for key, value in expected.items())


def rank(facts, target):
    source = [fact for fact in facts if fact["observation"]["source"]["sha256"] == target["source"]["sha256"]]
    quoted = [fact for fact in source if normalize(target["literal"]) in normalize(fact["observation"].get("quote") or "")]
    exact = [fact for fact in quoted if located(fact["observation"]["address"], target["address"])]
    return "exact" if exact else "same_text_wrong_address" if quoted else "version_only" if source else "not_observed"


def ndjson(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def window_contains(locator, expected):
    if "page" in expected:
        return locator.get("page") == expected["page"]
    if "paragraph" in expected:
        return locator.get("firstParagraph", 0) <= expected["paragraph"] <= locator.get("lastParagraph", -1)
    if "line" in expected:
        return locator.get("firstLine", 0) <= expected["line"] <= locator.get("lastLine", -1)
    if "cell" in expected:
        row = int(re.fullmatch(r"[A-Z]+(\d+)", expected["cell"])[1])
        return locator.get("sheet") == expected["sheet"] and locator.get("firstRow", 0) <= row <= locator.get("lastRow", -1)
    return locator.get("space") == expected.get("space")


def trace_target(target, rank_result, maps, replies):
    if rank_result == "exact":
        return "saved_exact"
    expected = target["address"]
    digest = target["source"]["sha256"]
    mapped = [unit for row in maps if row["sha256"] == digest
              for unit in row["units"] if window_contains(unit.get("locator", {}), expected)]
    if not mapped:
        return "target_window_missing_from_reader_map"
    opened = [reply for reply in replies if reply["evidence"]["place"]["source"]["sha256"] == digest
              and reply["evidence"]["place"]["unitId"] in {unit["id"] for unit in mapped}]
    if not opened:
        return "mapped_window_not_opened"
    texts = [json.loads(reply["content"]) for reply in opened if reply.get("content")]
    exact_lines = []
    for text in texts:
        address = text.get("address", {})
        for line in text.get("lines", []):
            merged = {**address, "locator": {**(address.get("locator") or {}), **(line.get("locator") or {})}}
            if normalize(target["literal"]) in normalize(line["text"]) and located(merged, expected):
                exact_lines.append(line)
    if exact_lines:
        return "delivered_exact_saved_as_different_address" if rank_result == "same_text_wrong_address" else "delivered_exact_not_saved"
    return "opened_native_text_without_exact_line" if texts else "opened_without_native_text"


def score(root, frozen, baseline_project, maps=None, replies=None, trace=None):
    oracle = root / "closed-oracle" / "oracle.json"
    oracle_sha = sha256(oracle.read_bytes()).hexdigest()
    assert read_json(root / "sealed-receipt.json")["oracle_sha256"] == oracle_sha, "oracle changed"
    gold = read_json(oracle)
    machine_input = read_json(frozen)
    assert machine_input.get("mode", "managed-test") == "managed-test"
    assert machine_input.get("qualifiesProduction", False) is False
    assert machine_input["balance"]["spentUsdNanos"] == 0
    assert machine_input["balance"]["reserveUsdNanos"] == 0
    machine = next(group for group in machine_input["readings"] if group["projectId"] == baseline_project)
    targets = [(key, target) for key in ("alias", "stage", "baseline") for target in anchors(gold[key])]
    mapped = ndjson(maps) if maps else []
    returned = ndjson(replies) if replies else []
    forwarded = ndjson(trace) if trace else []
    branches = {}
    for branch in ("A", "B"):
        facts = [fact for fact in machine["facts"] if fact["branch"] == branch]
        windows = Counter(window["branches"][branch]["status"] for window in machine["windows"])
        ids = {evidence["evidenceId"] for entry in forwarded if entry["branch"] == branch.lower()
               for evidence in entry["opened"]}
        delivered = [entry for entry in returned if entry["evidence"]["evidenceId"] in ids]
        scored = []
        for key, target in targets:
            rank_result = rank(facts, target)
            scored.append({"set": key, "address": target["address"], "sourceSha256": target["source"]["sha256"],
                           "result": rank_result,
                           **({"attribution": trace_target(target, rank_result, mapped, delivered)} if maps else {})})
        branches[branch] = {
            "addresses": dict(Counter(row["result"] for row in scored)),
            "windows": dict(windows),
            "sourceVersionsWithFacts": len({fact["observation"]["source"]["versionId"] for fact in facts}),
            "facts": len(facts),
            "addressesBySource": scored,
            **({"attribution": dict(Counter(row["attribution"] for row in scored))} if maps else {}),
        }
    return {
        "mode": "managed-test",
        "qualifiesProduction": False,
        "toolSha256": sha256(Path(__file__).read_bytes()).hexdigest(),
        "oracleSha256": oracle_sha,
        "frozenMachineSha256": sha256(frozen.read_bytes()).hexdigest(),
        "expectedAddressCount": len(targets),
        "sharedCoverage": machine["coverage"],
        "machineFacadeCandidates": len(machine["candidates"]),
        "expectedDistinctFacades": len(gold["facades"]),
        "comparisons": dict(Counter(pair["status"] for pair in machine["comparisons"])),
        "branches": branches,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("frozen", type=Path)
    parser.add_argument("baseline_project")
    parser.add_argument("output", type=Path)
    parser.add_argument("--maps", type=Path)
    parser.add_argument("--replies", type=Path)
    parser.add_argument("--trace", type=Path)
    args = parser.parse_args()
    assert not any((args.maps, args.replies, args.trace)) or all((args.maps, args.replies, args.trace))
    result = score(args.root, args.frozen, args.baseline_project, args.maps, args.replies, args.trace)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps({branch: {key: value[key] for key in ("addresses", "windows", "attribution") if key in value}
                      for branch, value in result["branches"].items()}))
