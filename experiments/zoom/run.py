"""Живой испытательный адаптер OpenRouter. Входы — только синтетические листы."""
import argparse
import base64
import fcntl
import hashlib
import io
import json
import math
import os
import re
from decimal import Decimal
from pathlib import Path
import subprocess

from PIL import Image

from evidence import evaluate_evidence
from session import AdmissionDeferred, KnownProviderFailure, record_response, run_session


MODELS = {"Qwen": "qwen/qwen4-max", "Kimi": "moonshotai/kimi-k3.1-pro",
          "DeepSeek": "deepseek/deepseek-v4.1-flash-1017"}
CASES = ("original", "changed", "moved", "missing", "foreign", "foreign_visible", "ambiguous", "drain")
QUESTION = ("Для позиции F-17 укажите монтажный зазор с единицей и контрольную маркировку рядом с ним. "
            "Укажите место на листе. Если сведения нельзя установить, сообщите об этом.")
SYSTEM = """Вы читаете инженерный лист s1 редакции v1. Обзор 720×480, оригинал 2160×1440.
Координаты [0,1], начало слева сверху. Используйте доступные источники по своему усмотрению.
Сохраняйте исходное начертание, сомнение об алфавите и альтернативы указывайте в note.
Если изображение, его заголовок или привязка расходятся с обзором, отметьте локальное расхождение.
Границы чтения одного места не позволяют устанавливать отсутствие данных на всём листе или в поставке.
Дайте итог одним JSON-объектом: status (found, insufficient либо mismatch), mark, value (число),
unit, code (один наблюдаемый вариант), locator (адрес из открытого фрагмента), note (пояснение по-русски).
Если поле неизвестно, допустим null. Сохраняйте установленные независимо поля."""
TOOLS = [{"type": "function", "function": {"name": "view_region",
    "description": "Открывает выбранный прямоугольник оригинала с читаемой детализацией.",
    "parameters": {"type": "object", "properties": {
        "unitRef": {"type": "string", "enum": ["s1"]},
        "selector": {"type": "object", "properties": {
            "kind": {"type": "string", "enum": ["rect"]},
            "viewRevisionId": {"type": "string", "enum": ["v1"]},
            "rect": {"type": "array", "items": {"type": "number"}, "minItems": 4,
                     "maxItems": 4, "description": "[left,top,right,bottom], нормированные координаты"}},
            "required": ["kind", "viewRevisionId", "rect"]}}, "required": ["unitRef", "selector"]}}}]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def image_part(data):
    return {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(data).decode()}}


def png(image):
    stream = io.BytesIO()
    image.save(stream, format="PNG")
    return stream.getvalue()


def write(path, data):
    tmp = path.with_suffix(".new")
    with tmp.open("w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def rectangle(call, size):
    args = json.loads(call["function"]["arguments"])
    selector = args["selector"]
    x, y, right, bottom = selector["rect"]
    if (call["function"]["name"] != "view_region" or args["unitRef"] != "s1" or
            selector["kind"] != "rect" or selector["viewRevisionId"] != "v1" or
            not (0 <= x < right <= 1 and 0 <= y < bottom <= 1)):
        raise ValueError("неверный адрес")
    w, h = size
    box = (math.floor(w*x), math.floor(h*y), math.ceil(w*right), math.ceil(h*bottom))
    if box == (0, 0, w, h):
        raise ValueError("целый лист доступен как стартовый обзор")
    return list(box)


def reader(original, supply, case):
    def execute(call, folder):
        event = {"id": call["id"], "locator": "s1/v1/" + call["id"]}
        try:
            box = rectangle(call, original.size)
        except (TypeError, ValueError, KeyError) as exc:
            event.update(status="invalid", detail=str(exc))
            content = json.dumps(event, ensure_ascii=False)
        else:
            reference = png(original.crop(box))
            offered = png(supply.crop(box))
            mismatch = digest(reference) != digest(offered)
            status = "mismatch" if mismatch else "verified"
            if case == "missing":
                status = "missing"
            event.update(sourceBox=box, expectedSha=digest(reference), candidateSha=digest(offered), status=status)
            # Inject visible corruption only in the explicitly named behavioural control.
            if status == "verified" or (mismatch and case == "foreign_visible"):
                (folder / "crop.png").write_bytes(offered)
                event["sentSha"] = digest(offered)
                content = [{"type": "text", "text": json.dumps({"locator": event["locator"], "box": box})},
                           image_part(offered)]
            else:
                content = json.dumps({"locator": event["locator"], "box": box, "status": status})
        write(folder / "receipt.json", event)
        return [{"role": "tool", "tool_call_id": call["id"], "content": content}]
    return execute


def transport(root, limit):
    def send(body, folder):
        key = os.environ["OPENROUTER_API_KEY"]
        if any(ch in key for ch in '\r\n"\\'):
            raise ValueError("Некорректный формат ключа")
        # Send exactly the saved UTF-8 bytes. Key lives in the private curl input.
        wire = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
        wire_path = folder / "wire.json"
        wire_path.write_bytes(wire)
        # For a continuation, the provider has already billed the unchanged prefix.
        # Reserve that measured prefix plus a margin, and bound the entire new suffix.
        new_messages = body["messages"]
        token_allowance = len(wire)
        previous = folder.parent / f"{int(folder.name)-1:04d}"
        if (previous/"response.json").is_file() and (previous/"wire.json").is_file():
            prior = json.loads((previous/"wire.json").read_bytes())
            reply = json.loads((previous/"response.json").read_bytes())
            counted = (reply.get("usage") or {}).get("prompt_tokens")
            prefix = prior["messages"]
            if (isinstance(counted, int) and counted > 0 and
                prior["model"] == body["model"] == reply.get("model") and prior["tools"] == body["tools"]
                and prior["provider"] == body["provider"] and new_messages[:len(prefix)] == prefix):
                new_messages = new_messages[len(prefix):]
                added = json.dumps(new_messages, ensure_ascii=False, separators=(",", ":")).encode()
                token_allowance = math.ceil(counted * 1.25) + 4096 + len(added)
        for msg in new_messages:
            for part in msg["content"] if isinstance(msg.get("content"), list) else []:
                if part.get("type") == "image_url":
                    pixels = base64.b64decode(part["image_url"]["url"].split(",", 1)[1], validate=True)
                    w, h = Image.open(io.BytesIO(pixels)).size
                    token_allowance += 4096 + math.ceil(w*h/64)
        prices = body["provider"]["max_price"]
        reserve = (Decimal(token_allowance+2048)*Decimal(str(prices["prompt"]))
                   + Decimal(body["max_tokens"])*Decimal(str(prices["completion"]))) * Decimal("1.10") / 1_000_000
        ledger_path = root / "charges.json"
        attempt = str(folder.relative_to(root))
        # Serial admission and settlement across processes. Unknown requests keep their reserve.
        with (root / "charges.lock").open("a") as guard:
            fcntl.flock(guard, fcntl.LOCK_EX)
            charges = json.loads(ledger_path.read_text()) if ledger_path.exists() else {}
            spent = sum(Decimal(x.get("cost", x["reserve"])) for x in charges.values())
            if attempt in charges:
                raise RuntimeError("Попытка уже зарезервирована")
            if spent + reserve > limit:
                write(folder / "admission.json", {"state":"not_dispatched","required":str(reserve),
                                                    "accounted":str(spent),"limit":str(limit)})
                raise AdmissionDeferred("Недостаточен остаток лимита, отправки не было")
            charges[attempt] = {"reserve": str(reserve)}
            write(ledger_path, charges)
            cmd = ["curl", "-sS", "--connect-timeout", "15", "--max-time", "180", "--config", "-",
                   "-H", "Content-Type: application/json", "-H", "X-OpenRouter-Metadata: enabled",
                   "--dump-header", str(folder/"response-headers.txt"),
                   "--data-binary", "@"+str(wire_path), "-w", "\n%{http_code}",
                   "https://openrouter.ai/api/v1/chat/completions"]
            result = subprocess.run(cmd, input='header = "Authorization: Bearer '+key+'"\n',
                                    text=True, capture_output=True)
            if result.returncode:
                write(folder / "transport-error.json", {"curlExit": result.returncode,
                      "detail": result.stderr.strip(), "receivedBytes": len(result.stdout.encode())})
                if result.stdout:
                    (folder / "partial-response.txt").write_text(result.stdout)
                raise RuntimeError("Неизвестный сетевой исход")
            raw, http = result.stdout.rsplit("\n", 1)
            data = json.loads(raw)
            if int(http) != 200:
                write(folder / "error.json", data)
                if int(http) in (400, 401, 402, 403, 404, 413, 422) and not data.get("id"):
                    charges[attempt]["cost"] = "0"
                    write(ledger_path, charges)
                    raise KnownProviderFailure("OpenRouter HTTP "+http)
                raise RuntimeError("Неустановленный исход: OpenRouter HTTP "+http)
            record_response(folder, data)
            cost = (data.get("usage") or {}).get("cost")
            if cost is None:
                raise RuntimeError("Не получен фактический расход")
            charges[attempt]["cost"] = str(cost)
            write(ledger_path, charges)
            return data
    return send


def parse_answer(raw):
    text = raw.strip()
    blocks = re.findall(r"^```(?:json)?[ \t]*\n(.*?)\n```[ \t]*$", text, re.M | re.S)
    if len(blocks) == 1:
        outside = re.sub(r"^```(?:json)?[ \t]*\n.*?\n```[ \t]*$", "", text,
                         flags=re.M | re.S)
        if "{" in outside or "}" in outside:
            return {}
        text = blocks[0]
    elif blocks:
        return {}
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else {}
    except ValueError:
        return {}


def address_receipts(locator, receipts):
    """Resolve only complete tool-issued references, including inside a human-readable citation."""
    if not isinstance(locator, str):
        return []
    ids = set(re.findall(r"(?<![\w/])s1/v1/[A-Za-z0-9_-]+(?=$|[\s,;:)\]»]|\.(?=\s|$))", locator))
    available = {item["locator"]: item for item in receipts if item.get("sentSha")}
    if not ids or not ids.issubset(available):
        return []
    return [available[ref] for ref in sorted(ids)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("branch", choices=MODELS)
    parser.add_argument("case", choices=CASES)
    fields = parser.add_mutually_exclusive_group()
    fields.add_argument("--clarified-fields", dest="clarified_fields", action="store_true", default=True,
                        help="Текущий профиль с точными определениями полей (по умолчанию)")
    fields.add_argument("--legacy-fields", dest="clarified_fields", action="store_false",
                        help="Воспроизвести архивную серию с прежним назначением полей")
    parser.add_argument("--limit", required=True, type=Decimal, help="Потолок расходов этой серии, USD")
    args = parser.parse_args()
    root, branch, case = args.root.resolve(), args.branch, args.case
    sheets = root/("qualification-sheets" if args.clarified_fields else "sheets")
    fixture = sheets/(case if case in ("changed", "moved") else "original")
    base = Image.open(fixture/"reader/sheet.png")
    supply = Image.open(sheets/"foreign-injection.png") if case.startswith("foreign") else base
    alphabet = None if case == "ambiguous" else "ascii_hex"
    rule = ("Алфавит маркировки каталогом не задан." if alphabet is None else
            "Каталог этого учебного поля: маркировка — шесть символов ASCII из 0123456789ABCDEF.")
    assignment = SYSTEM + "\n" + rule
    if args.clarified_fields:
        assignment += ("\nПоля относятся к разным надписям. mark — обозначение позиции в заголовке "
                       "осмотренной карточки. code — значение отдельной строки «Маркировка» этой карточки. "
                       "В locator поместите только выданный адрес, пояснения оставьте в note. "
                       "Когда начертание неоднозначно, сохраните его в code, возможные варианты в note. "
                       "Если оснований для ответа о запрошенной позиции нет, оставьте её поля null.")
    initial = [{"role":"system","content":assignment},
               {"role":"user","content":[{"type":"text","text":QUESTION},image_part((fixture/"input/overview.png").read_bytes())]}]
    provider = {"only":["alibaba"],"allow_fallbacks":False,"require_parameters":True,
                "max_price":{"prompt":2,"completion":10}}
    if branch == "DeepSeek":
        provider.update(only=["alibaba"], ignore=["alibaba/prime"], max_price={"prompt": 0.3, "completion": 1.2})
    if branch == "Kimi":
        provider["ignore"] = ["alibaba/prime"]
    profile = {"model":MODELS[branch],"provider":provider,"tools":TOOLS,"max_tokens":2400,"stream":False}
    series = root/"qualification" if args.clarified_fields else root
    if branch == "DeepSeek":
        series = series/"deepseek-alibaba"
    folder = series/(branch+"-"+case)
    binding = {"readerVersion": 1, "case": case, "alphabet": alphabet,
               "sheetSha": digest((fixture/"reader/sheet.png").read_bytes()),
               "supplySha": digest((sheets/"foreign-injection.png").read_bytes()) if case.startswith("foreign")
                           else digest((fixture/"reader/sheet.png").read_bytes()),
               "overviewSha": digest((fixture/"input/overview.png").read_bytes())}
    session = run_session(folder, reader_binding=binding, initial_messages=initial, request_options=profile, send=transport(root,args.limit),
                execute_tool=reader(base,supply,case), max_tool_rounds=1 if case=="drain" else 4,
                synthesis_max_tokens=4800 if args.clarified_fields else None)
    receipts = [json.loads(p.read_text()) for p in sorted(folder.glob("attempts/*/tools/*/receipt.json"))]
    if not session["final_answer_received"]:
        statuses = {e["status"] for e in receipts}
        source_status = "mismatch" if "mismatch" in statuses else "missing" if statuses == {"missing"} else "unassessed"
        write(folder/"outcome.json", {"branch":branch, "case":case, "state":session["status"],
                                      "reason": session["reason"], "sourceStatus": source_status,
                                      "decision": evaluate_evidence({}, alphabet=alphabet, source_status=source_status),
                                      "receipts": receipts})
        raise RuntimeError(f'{branch}/{case}: {session["status"]}')
    raw = session["final_message"].get("content") or ""
    answer=parse_answer(raw)
    addressed = address_receipts(answer.get("locator"), receipts)
    source_status=("mismatch" if any(e["status"]=="mismatch" for e in receipts)
                   else "verified" if any(e["status"]=="verified" for e in addressed) else "missing")
    decision=evaluate_evidence(answer, alphabet=alphabet, source_status=source_status)
    write(folder/"outcome.json",{"branch":branch,"case":case,"alphabet":alphabet,"sourceStatus":source_status,
                                 "answer":answer,"rawText":raw,"decision":decision,"receipts":receipts,
                                 "resolvedLocators":[e["locator"] for e in addressed]})
    print(branch,case,source_status,raw,flush=True)


if __name__=="__main__":
    os.umask(0o077)
    main()
