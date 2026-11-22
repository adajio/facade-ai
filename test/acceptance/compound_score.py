"""Compare compound support against a closed oracle after the machine snapshot.

The existing exact-address scorer runs separately. A compound observation can
retain a value-cell address and still link independently opened context.
"""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import re

from score import address_matches, load


def canonical_unit(unit):
    return {"мм": "mm", "м": "m"}.get(unit, unit)


def address(citation):
    raw = citation["address"]
    locator = raw.get("locator", {})
    direct = locator.get("place") or locator.get("propertyPath")
    if locator.get("page"):
        direct = f'page:{locator["page"]}'
    elif locator.get("line"):
        direct = f'line:{locator["line"]}'
    elif all(field in locator for field in ("table", "row", "column")):
        direct = f'table:{locator["table"]}/R{locator["row"]}C{locator["column"]}'
    elif locator.get("sheet") and locator.get("cell"):
        direct = f'{locator["sheet"]}!{locator["cell"]}'
    box = raw.get("box")
    return {"unit": direct, "box": [box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]]
            if box else None, "wholeUnit": not box}


def named_ifc_property(place, citation, parts):
    expected = place["address"]["unit"]
    segments = expected.split("/")
    if place["format"] != "ifc" or len(segments) != 2 or "." not in segments[1]:
        return False
    group, prop = segments[1].split(".", 1)
    coordinates = citation["address"].get("locator", {})
    return (coordinates.get("step") is not None and prop in citation["quote"]
            and any(segments[0] in part["quote"] for part in parts)
            and any(group in part["quote"] for part in parts))


def measured_place(place, citation, parts):
    key = address(citation)
    goal = place["address"]
    if address_matches(goal, key) or named_ifc_property(place, citation, parts):
        return True
    if place["format"] in {"dwg", "dxf"} and goal["unit"].startswith("model:"):
        locator = citation["address"].get("locator", {})
        target = goal["unit"].removeprefix("model:").split("/", 1)
        return (len(target) == 2 and str(locator.get("space", "")).lower() == "model"
                and any(field in locator for field in ("handle", "derivativeHandle", "entityOrdinal"))
                and any(target[0] in part["quote"] for part in parts)
                and any(part["role"] == "variant" and part["literal"] == target[1] for part in parts))
    if not goal.get("box") or key["unit"] != goal["unit"] or not key["box"]:
        return False
    x1, y1, x2, y2 = goal["box"]
    a, b, c, d = key["box"]
    return x1 <= a <= c <= x2 and y1 <= (b + d) / 2 <= y2


def own_observation(records, models, accepted, branches, row):
    cite = row["finding"]["citation"]
    parts = cite.get("components", [])
    branch = cite["branch"]
    if not parts or branches.get(row["job_id"]) != "primary_" + branch.lower():
        return False
    evidence_ids = {part["evidenceId"] for part in parts}
    evidence_ids.add(cite["evidenceId"])
    accepted_turn = accepted.get((row["job_id"], cite["observationId"]))
    event = models.get((row["job_id"], accepted_turn))
    actual = event and evidence_ids.issubset(event["inputRefs"])
    if not actual:
        return False
    return all((record := records.get(part["evidenceId"])) and record["job_id"] == row["job_id"]
               and record["scope_id"] == row["scope_id"] and record["branch"] == branch and record["source"] == part["source"]
               for part in parts)


def score(oracle, machine, api, api_openings):
    expected_positions = {identifier: position for position, decision in oracle["letter"]["decisions"].items()
                          for identifier in decision["sources"]}
    # These Southern-pier positions are independently identified by their delivered labels in the baseline report.
    expected_positions.update({"other-scope": "gap", "other-pdf-gap": "gap", "other-pdf-raster": "offset"})
    questions = {q["id"]: (scope, q) for scope, data in api.items() if scope != "letters"
                 for q in data["assessment"]["questions"]}
    cards = {q["id"]: {cite["observationId"] for cite in q["machine"]["citations"]} for _, q in questions.values()}
    records = {row["id"]: row for row in machine["representation"]}
    branches = {job["id"]: job["purpose"] for job in machine["jobs"]}
    models = {}
    accepted = {}
    for row in machine["trace"]:
        event = row["event"]
        if event["kind"] == "model":
            models[(row["job_id"], event["turn"])] = event
        if event["kind"] == "tool" and (observation := event["reply"].get("observation")):
            accepted[(row["job_id"], observation["id"])] = event["turn"]

    result = []
    for place in oracle["places"]:
        matches = {"A": [], "B": []}
        position = expected_positions.get(place["id"])
        target_variant = re.search(r"/([A-Z])$", place["address"]["unit"]) if place["format"] in {"dwg", "dxf"} else None
        for row in machine["observations"]:
            key = questions.get(row["question_id"])
            if not key or key[0] != place["scope"] or key[1]["requirement"]["positionId"] != position:
                continue
            finding = row["finding"]
            cite = finding["citation"]
            parts = cite.get("components", [])
            if (cite["sha256"] != place["originalSha256"] or not own_observation(records, models, accepted, branches, row)
                    or not measured_place(place, cite, parts)):
                continue
            value_matches = any(expected["value"] == cite.get("value") and
                                expected["unit"] == canonical_unit(cite.get("unit")) for expected in place["variants"])
            explicit_unit = any(part["role"] == "unit" for part in parts)
            variant = next((part["literal"] for part in parts if part["role"] == "variant"), None)
            revision = next((part["literal"] for part in parts if part["role"] == "revision"
                             and part["source"]["versionId"] == cite["versionId"]), None)
            variant_matches = target_variant is None or variant == target_variant[1]
            on_card = cite["observationId"] in cards[row["question_id"]]
            opened = api_openings.get(cite["observationId"], {})
            all_opened = on_card and all(opened.get(part["evidenceId"]) == part["source"]["sha256"] for part in parts)
            active = finding["kind"] == "value" and finding["applicability"] == "active"
            matches[cite["branch"]].append({"observationId": cite["observationId"], "valueMatches": value_matches,
                "explicitUnit": explicit_unit, "variantMatches": variant_matches,
                "revisionMatches": revision == place["revision"], "onCard": on_card,
                "componentsReopened": all_opened, "active": active,
                "complete": value_matches and explicit_unit and variant_matches and revision == place["revision"] and all_opened and active})
        result.append({"id": place["id"], "scope": place["scope"], "readability": place["readability"], "branches": matches})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("oracle", "machine", "api", "openings"):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    oracle, raw, api, proof = (load(getattr(args, name)) for name in ("oracle", "machine", "api", "openings"))
    places = score(oracle, raw["main"], api, proof)
    readable = [place for place in places if place["readability"] == "readable"]
    assert len(readable) == 11 and len(places) == 12
    fields = ("valueMatches", "explicitUnit", "variantMatches", "revisionMatches", "onCard", "componentsReopened", "active", "complete")
    print(json.dumps({"oracleSha256": sha256(args.oracle.read_bytes()).hexdigest(),
        "readable": len(readable), "unreadable": len(places) - len(readable),
        "summary": {branch: {field: sum(any(hit[field] for hit in place["branches"][branch]) for place in readable)
                             for field in fields} for branch in ("A", "B")}, "places": places}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
