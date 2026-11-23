"""Convert an actual two-reader exchange to addressed work results for ordinary intake."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json

from .assessment_prefix import recover_reading
from .intake_checks import paired_outcome
from .research import digest, save


def read_assignment(task, units, *, readers, evidence_dir, deliver, ask, open_more=None,
                    turns_per_lease=4):
    """Suitable as ordinary_upload's inspect and inspect_variant callback.

    deliver(task, units) returns the actual message parts and {unit: line indexes} for this view.
    ask(model, parts, attempt_directory) journals the wire and returns content, finish_reason
    and a distinct receipt for these exact parts. The gateway controls paid retry and binding.
    """
    refs = task["units"]
    work = task.get("work_id") or task["task_id"]
    folder = Path(evidence_dir) / work
    parts, allowed = deliver(task, units)
    if len(refs) != 2 or set(allowed) != set(refs):
        raise ValueError("two actual source views are required")
    scope = folder / digest(parts)
    results, evidence = {}, []

    def one(reader):
        if turns_per_lease < 1:
            raise ValueError("a lease needs at least one response")
        material = list(parts)
        locations = {u: set(ids) for u, ids in allowed.items()}
        turn, fresh = 0, 0
        prefix_digests = set()
        earlier = []
        while True:
            turn += 1
            turn_dir = scope / reader / str(turn)
            accepted = turn_dir / "accepted.json"
            if accepted.exists():
                response = json.loads(accepted.read_bytes())
            else:
                response = ask(reader, material, turn_dir)
                fresh += 1
            receipt = response.get("receipt")
            if (not isinstance(receipt, str) or not receipt.strip()
                    or response.get("material_digest") != digest(material)):
                raise ValueError("missing receipt for delivered material")
            if not accepted.exists():
                save(accepted, {k: response.get(k) for k in
                                ("receipt", "material_digest", "content", "finish_reason")})
            raw = response.get("content") or ""
            text = raw.strip()
            if text.startswith("```"):
                text = text.partition("\n")[2].rsplit("```", 1)[0].strip()
            try:
                record, _ = json.JSONDecoder().raw_decode(text)
            except ValueError:
                record = None
            if not isinstance(record, dict):
                record = recover_reading(raw, response.get("finish_reason"), locations)
                if record["sources"] or record["entries"]:
                    fingerprint = digest(record)
                    save(turn_dir / "partial.json", {"receipt": receipt, "reading": record})
                    if fingerprint not in prefix_digests:
                        earlier.append({"receipt": receipt, "reading": record})
                        prefix_digests.add(fingerprint)
                        if fresh < turns_per_lease:
                            material = material + [{"type": "text", "text": json.dumps({
                                "accepted_partial_reading": record,
                                "request": "Прочтите оставшееся. Верните краткое сопоставление "
                                           "с адресами обеих сторон или укажите требуемое открытие."
                            }, ensure_ascii=False)}]
                            continue
            calls = record.get("calls", [])
            if not calls:
                break
            # Persist the original request before asking the reader to open anything.
            record = {**record, "decision": "unresolved", "pending_calls": calls}
            save(turn_dir / "requested.json", record)
            if (open_more is None or fresh >= turns_per_lease
                    or not isinstance(calls, list)):
                break
            added = []
            cached_views = turn_dir / "views.json"
            if cached_views.exists():
                views = json.loads(cached_views.read_bytes())
                for ref, ids in views["lines"].items():
                    locations[ref].update(ids)
                material = material + views["parts"]
                continue
            next_lines = {}
            for call in calls:
                if (not isinstance(call, dict) or call.get("ref") not in refs
                        or call.get("op") not in {"read", "view"}):
                    break
                try:
                    extra, indices = open_more(reader, call, units)
                except Exception as exc:
                    record["tool_error"] = str(exc) or type(exc).__name__
                    break
                if not extra or set(indices) != {call["ref"]}:
                    break
                next_lines.setdefault(call["ref"], []).extend(indices[call["ref"]])
                added.extend(extra)
            else:
                delivered = [{"type": "text", "text": json.dumps(calls, ensure_ascii=False)}] + added
                save(cached_views, {"lines": next_lines, "parts": delivered})
                for ref, ids in next_lines.items():
                    locations[ref].update(ids)
                material = material + delivered
                continue
            break
        source_rows = []
        for source in record.get("sources") or []:
            if not isinstance(source, dict):
                continue
            ref, loc, reading = source.get("ref"), source.get("lines"), source.get("reading")
            if (isinstance(ref, str) and ref in locations and isinstance(loc, list) and loc
                    and all(type(i) is int and i in locations[ref] for i in loc)
                    and isinstance(reading, str) and reading.strip()):
                source_rows.append(source)
        record = {**record, "sources": source_rows, "prior_partial_readings": earlier}
        return record, [{"reader": reader, "unit": s["ref"], "receipt": receipt + "#" + s["ref"],
                         "location": s["ref"] + "#L" + ",".join(map(str, s["lines"]))}
                        for s in source_rows]

    with ThreadPoolExecutor(max_workers=len(readers)) as pool:
        futures = {m: pool.submit(one, m) for m in readers}
        for reader, future in futures.items():
            try:
                results[reader], receipts = future.result()
                evidence.extend(receipts)
            except Exception as exc:
                results[reader] = {"error": str(exc) or type(exc).__name__}
    status, closed = paired_outcome(list(results.values()), refs)
    # Technical completion records that the pair was read. Field agreement, applicability
    # and permission for an external question must be decided in the fact review.
    save(scope / "addressed.json", {"task": work, "results": results, "receipts": evidence,
                                    "technical_status": status})
    return status, evidence, closed
