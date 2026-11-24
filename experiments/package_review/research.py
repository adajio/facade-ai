"""A blind research lane with a durable distinction between requested, delivered and cited evidence."""
import hashlib
import json
import os
import tempfile

if __package__:
    from .partial_response import complete_observations
else:
    from partial_response import complete_observations
from pathlib import Path


def save(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(data, out, ensure_ascii=False)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def decode_message(raw):
    """Handle object and item-list envelopes. Preserve the original response at the adapter."""
    text = raw.strip()
    if text.startswith("```") and text.endswith("```"):
        text = text.partition("\n")[2].rsplit("```", 1)[0].strip()
    try:
        value = json.loads(text)
    except ValueError:
        return [], [], False, ["unparsed"]
    if isinstance(value, list):
        grouped = {"observations": [], "calls": []}
        for item in value:
            key = "calls" if isinstance(item, dict) and "op" in item else "observations"
            grouped[key].append(item)
        value = grouped
    if not isinstance(value, dict):
        return [], [], False, ["unexpected envelope"]
    facts, calls, issues = [], [], []
    for key, dest, required in (("observations", facts, "fact"), ("calls", calls, "op")):
        items = value.get(key, [])
        if not isinstance(items, list):
            issues.append(f"{key}: expected array")
            continue
        for i, item in enumerate(items):
            if isinstance(item, dict) and isinstance(item.get(required), str) and item[required].strip():
                dest.append(item)
            else:
                issues.append(f"{key}[{i}]: missing {required}")
    return facts, calls, value.get("done") is True, issues


def digest(parts):
    return hashlib.sha256(json.dumps(parts, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def text_part(text):
    return {"type": "text", "text": text}


def run_lane(folder, *, role, inventory, steps, ask, execute):
    """ask(folder, system, parts, final) returns text or {text, finish_reason}; execute(call) returns wire parts.

    The caller gives each run a distinct immutable input profile, and enforces
    dispatch idempotence. A complete lane is frozen before any peer can see it.
    """
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    profile = {"role": role, "inventory": inventory, "steps": steps}
    identity = folder / "lane-profile.json"
    if identity.exists() and json.loads(identity.read_bytes()) != profile:
        raise ValueError("Research profile changed")
    save(identity, profile)
    frozen = folder / "frozen.json"
    if frozen.exists():
        return json.loads(frozen.read_bytes())
    results, history, candidates, delivered, gaps = [], [], [], {}, []
    recent = []
    stop = "research_window_exhausted"
    for step in range(1, steps + 2):
        final = step == steps + 1
        work = folder / f"{step:02}"
        work.mkdir(exist_ok=True)
        prior_refs = [{"receipt": k, "op": v["call"]} for k, v in delivered.items()]
        previous = [{"fact": c["fact"], "refs": c.get("refs", [])} for c in candidates]
        context = ("Опись:\n" + inventory + "\nВаши уже сохранённые наблюдения:\n" +
                   json.dumps(previous, ensure_ascii=False) + "\nИстория выданных материалов:\n" +
                   json.dumps(prior_refs, ensure_ascii=False))
        phase = ("Заключительный ход: оформите наблюдения по всем уже полученным результатам. "
                 "Новые открытия будут отмечены как незавершённые." if final else
                 "Продолжайте собственное исследование; выбирайте адреса по описи и результатам.")
        recall_help = 'Из прежних ходов можно повторно запросить материал: {"op":"recall","receipt":"E<ход>.<номер>"}.'
        parts = [text_part(context + "\n" + phase + "\n" + recall_help)] + recent
        raw = ask(work, role, parts, final)
        # Only a successful response makes these tool results delivered.
        for receipt in results:
            delivered[receipt["id"]] = receipt
        reply_text = raw["text"] if isinstance(raw, dict) else raw
        observations, calls, done, issues = decode_message(reply_text)
        truncated = isinstance(raw, dict) and raw.get("finish_reason") == "length" and "unparsed" in issues
        if truncated:
            observations = complete_observations(reply_text)
        if issues:
            gaps.append({"step": step, "issues": issues})
        for i, record in enumerate(observations, 1):
            if truncated:
                record = {**record, "recovered_complete_item": True}
            refs = record.get("refs", [])
            if not isinstance(refs, list):
                refs = [refs]
            valid = [x for x in refs if isinstance(x, str) and x in delivered
                     and delivered[x]["status"] == "ok"]
            candidates.append({**record, "refs": refs, "delivered_refs": valid, "step": step, "item": i})
        history.append({"step": step, "calls": calls, "done": done, "issues": issues})
        if final:
            if calls:
                gaps.append({"step": step, "unserved": calls})
            break
        if done and not calls and step > 1 and not issues:
            stop = "reader_finished"
            break
        previous_parts = recent
        recent, results = [], []
        for i, call in enumerate(calls, 1):
            receipt_id = f"E{step}.{i}"
            try:
                original = None
                if call["op"] == "recall":
                    original = delivered[call.get("receipt")]
                    if original["status"] != "ok":
                        raise ValueError("Earlier receipt has no successful material")
                    payload = original["parts"]
                else:
                    payload = execute(call)
                if not payload:
                    raise ValueError("empty tool result")
                status = "ok"
            except (KeyError, ValueError, TypeError, IndexError, OSError) as exc:
                payload = [text_part(str(exc)[:400])]
                status = "error"
            receipt = {"id": receipt_id, "call": original["call"] if original and status == "ok" else call, "status": status, "sha256": digest(payload),
                       "parts": payload}
            if call["op"] == "recall":
                receipt["requested"] = call
            results.append(receipt)
            recent.extend([text_part(f"Квитанция {receipt_id} | {status} | {call}")] + payload)
        save(work / "issued.json", results)
        if not calls:
            recent = (previous_parts if issues else []) + [text_part("Последний ответ сохранён. Верните JSON с наблюдениями и следующими адресами, либо done=true.")]
        save(folder / "checkpoint.json", {"history": history, "candidates": candidates, "gaps": gaps})
    snapshot = {"stop": stop, "history": history, "candidates": candidates, "delivered": delivered, "gaps": gaps}
    save(folder / "frozen.json", snapshot)
    return snapshot
