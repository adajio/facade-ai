"""Deterministic answer for the isolated release rehearsal. Reads only synthetic input."""
import json
import re
import sys


def main():
    request = json.load(sys.stdin)
    model = request["model"]
    tool_name = request["tools"][0]["function"]["name"]
    assert model == "gpt-6.1-terra"
    assert tool_name == "submit_preliminary_review", tool_name
    prompt = json.loads(request["messages"][1]["content"])
    files = {}
    for number, (directory_id, name_id, *_) in enumerate(prompt["files"], start=1):
        directory = prompt["directories"][directory_id - 1]
        name = prompt["names"][name_id - 1]
        files[f"{directory}/{name}" if directory else name] = number
    controls = {
        "doc.facades": (
            ("mtext.dwg", r"FACADE RIB(?:\s|\^J)+67\.25 mm"),
            ("north.jpg", r"FACADE RIB\s+42\s+MM"),
        ),
        "doc.architecture": (("north.jpg", r"FACADE NORTH"),),
        "doc.architecture_details": (("scan.pdf", r"mixed construction sheet"),),
        "doc.facade_brief": (("brief.pdf.sig", r"not included"),),
        "doc.glazing": (("schedule.doc", r"2\.40 mm"),),
    }
    rows = []
    for item in prompt["requirements"]:
        key = item["key"]
        citations = []
        for path, pattern in controls.get(key, ()):
            for line_id, number, _locator, literal, *_ in prompt["lines"]:
                if number == files.get(path) and (match := re.search(pattern, literal, re.IGNORECASE)):
                    citations.append({"id": line_id, "quote": match.group(0)})
                    break
        status = "partial" if citations else "unassessed"
        finding = "Есть адресная опора. Требуется сверить объём." if citations else "Требуется сверка инженером."
        analysis = {
            "applicability": {
                "kind": "undetermined",
                "reason": "Применимость к фасадной подсистеме требует сверки с описью.",
                "citations": [],
            },
            "properties": [],
            "tensions": [],
        }
        rows.append({"key": key, "status": status, "finding": finding, "citations": citations, "analysis": analysis})
    facades = next((row for row in rows if row["key"] == "doc.facades"), None)
    if facades and len(facades["citations"]) == 2:
        facades["finding"] = "Для FACADE RIB получены два разных размера. Требуется уточнить применимую редакцию."
        first, second = facades["citations"]
        facades["analysis"] = {
            "applicability": {
                "kind": "included",
                "reason": "Два источника называют одну фасадную деталь.",
                "citations": [first, second],
            },
            "properties": [{
                "key": "rib-size", "label": "Размер FACADE RIB", "status": "conflicting",
                "finding": "Указаны 67.25 mm и 42 mm.", "citations": [], "response": None,
                "letter": {
                    "kind": "ask",
                    "text": "Для детали FACADE RIB в mtext.dwg указан размер 67.25 mm, на странице 1 north.jpg — 42 mm. Просим уточнить применимый размер для рабочей редакции.",
                },
            }],
            "tensions": [{
                "key": "rib-values", "propertyKey": "rib-size", "status": "open",
                "finding": "Для одной детали указаны разные размеры.",
                "sides": [{"text": "67.25 mm в чертеже.", "citations": [first]},
                          {"text": "42 mm на изображении.", "citations": [second]}],
                "resolutionCitations": [],
            }],
        }
    result = {"rows": rows}
    print(json.dumps({
        "model": model,
        "choices": [{"finish_reason": "tool_calls", "message": {"tool_calls": [{
            "type": "function", "function": {"name": tool_name, "arguments": json.dumps(result, ensure_ascii=False)}
        }]}}]
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
