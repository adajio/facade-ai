"""Find and deliver source lines without selecting positions or inferring quantities."""

from collections import Counter
import re


_HEADING = re.compile(
    r"\b(?:ведомост[ьи]|спецификаци[яий]|экспликаци[яиюй]|перечень|таблиц[аы]|"
    r"schedules?|specifications?|tables?|bill of materials)\b", re.IGNORECASE,
)
_CONTINUATION = re.compile(r"\b(?:продолжени[ея]|continu(?:ed|ation)|cont\.)", re.IGNORECASE)
_CROSS_REFERENCE = re.compile(r"\b(?:см\.|смотри|согласно|see|refer to)(?:\s|$)", re.IGNORECASE)
_COLUMN_ROLE = re.compile(
    r"^(?:поз\.?|позиция|марка|шифр|обозначение|наименование|описание|кол\.?[- ]?во|"
    r"количество|ед\.|единица|масса|вес|площадь|размер[ы]?|материал|примеча(?:-?|ние)|"
    r"итого|всего|item|mark|designation|name|description|qty\.?|quantity|unit|mass|"
    r"weight|area|dimensions?|material|remarks?|notes?|total)(?=\W|$)", re.IGNORECASE,
)
_CAD_LINE = re.compile(r"^(d\d+:h[\dA-F]+) \S+ (.*?)(?: \| (?:xy=|блок |d\d+:g)|$)", re.I)
_CAD_VIEW = frozenset(("cad_group", "cad_view"))
_VISUAL = _CAD_VIEW | {"pdf", "image"}
_CATALOG_PAGE = 32
_RAW_CHARS = 72_000
_CONTENT_CHARS = 19_000
_READ_ROWS = 260
_EMPTY_PDF_TEXT = "[Текстовый слой пуст]"
_PDF_OCR_SEPARATOR = "[Дополнение OCR rus+eng, проверить на изображении]"


def _ref(line_ref, index):
    return f"{line_ref}#L{index}"


def _check_start(start, total):
    if type(start) is not int or not 0 <= start <= total:
        raise ValueError(f"start должен быть целым числом от 0 до {total}")


def _segments(line):
    return [cell.strip() for cell in re.split(r"\t+| {2,}| *\| *", line) if cell.strip()]


def _text_layers(unit):
    lines = unit["lines"]
    kind = unit["kind"]
    sources = {"word": "word_xml", "image": "image_ocr_or_reader_note"}
    if kind != "pdf":
        return [{"source": sources.get(kind, "cad_export"), "range": [0, len(lines)]}] if lines else []
    if not lines:
        return []
    if lines == [_EMPTY_PDF_TEXT]:
        return [{"source": "reader_note", "range": [0, 1]}]
    if _PDF_OCR_SEPARATOR in lines:
        split = lines.index(_PDF_OCR_SEPARATOR)
        return [{"source": "pdf_text_layer", "range": [0, split]},
                {"source": "reader_note", "range": [split, split + 1]},
                {"source": "pdf_ocr", "range": [split + 1, len(lines)]}]
    source = "pdf_text_layer"
    if "LibreOffice" in unit["title"]:
        source = "word_pdf_conversion"
    elif "OCR" in unit["title"]:
        source = "pdf_ocr"
    return [{"source": source, "range": [0, len(lines)]}]


def _scan_unit(ref, unit):
    headings, headers, continuations, table_rows = [], [], [], []
    previous = None
    kind = unit["kind"]
    for i, line in enumerate(unit["lines"]):
        cad = _CAD_LINE.match(line) if kind.startswith("cad_") else None
        if kind.startswith("cad_") and not cad:
            continue
        segments = _segments(cad[2] if cad else line)
        row_ref = _ref(ref, i)
        column_roles = {match[0].lower().strip(".") for cell in segments if (match := _COLUMN_ROLE.match(cell))}
        if len(column_roles) >= 2:
            headers.append(i)
        for cell in segments:
            if _HEADING.search(cell):
                heading = {"row_ref": row_ref, "text": cell[:240]}
                if cad:
                    heading["source_ref"] = cad[1]
                if _CROSS_REFERENCE.search(cell) or re.match(r"\d+[.)]", cell):
                    heading["form"] = "mention"
                else:
                    heading["form"] = "heading"
                headings.append(heading)
            if _CONTINUATION.search(cell):
                continuations.append({"row_ref": row_ref, "text": cell[:240]})

        # Repeated layout positions are only a lead for a possible unlabelled table.
        if kind == "pdf":
            starts = tuple(match.end() for match in re.finditer(r"\S {2,}(?=\S)", line))
            if len(starts) >= 2 and re.search(r"[^\W\d_]{2,}", line) and re.search(r"\d", line):
                if previous and i <= previous[0] + 2:
                    aligned = sum(any(abs(x - y) <= 2 for y in previous[1]) for x in starts)
                    if aligned >= 2:
                        table_rows.extend((previous[0], i))
                previous = i, starts

    signals = []
    if headings:
        signals.append("source_title")
    if headers:
        signals.append("column_header")
    if kind == "word" and " / таблица / " in unit["title"]:
        signals.append("word_table")
    if len(set(table_rows)) >= 3:
        signals.append("aligned_rows")
    if continuations:
        signals.append("continuation_text")
    if kind == "image" or (kind == "pdf" and (not unit["lines"] or "OCR" in unit["title"]
                                              or unit["lines"] == [_EMPTY_PDF_TEXT])):
        signals.append("visual_check")
    return headings, headers, continuations, signals


class ScheduleReader:
    """Adapter over the original reader's ordered document and unit dictionaries."""

    def __init__(self, docs, units):
        self.docs = docs
        self.units = units
        self._signals = {}
        self._candidates = {}
        for doc_ref, doc in docs.items():
            candidates = []
            for ref in doc["units"]:
                unit = units[ref]
                headings, headers, continuations, signals = _scan_unit(ref, unit)
                self._signals[ref] = (headings, headers, continuations)
                if unit["kind"] == "cad_group" and not signals:
                    signals.append("drawing_for_visual_check")
                if unit["kind"] == "cad_index" and not signals:
                    signals.append("drawing_text_index")
                if signals:
                    candidates.append({
                        "ref": ref, "kind": unit["kind"], "title": unit["title"],
                        "signals": signals, "source_titles": headings[:8],
                        "header_refs": [_ref(ref, i) for i in headers[:12]],
                        "continuation_refs": list(dict.fromkeys(m["row_ref"] for m in continuations))[:8],
                        "line_count": len(unit["lines"]), "view_ref": self._view_ref(ref),
                        "viewports": unit.get("views", []),
                    })
            self._candidates[doc_ref] = tuple(candidates)

    def _view_ref(self, ref):
        return ref if self.units[ref]["kind"] in _VISUAL else None

    def catalog(self, start=0, doc_ref=None):
        """List candidate units mechanically in source inventory order."""
        selected = self.docs if doc_ref is None else {doc_ref: self.docs[doc_ref]}
        candidates = [item for key in selected for item in self._candidates[key]]
        documents = []
        for key, doc in selected.items():
            counts = Counter(self.units[ref]["kind"] for ref in doc["units"])
            documents.append({
                "ref": key, "name": doc["name"], "format": doc["format"], "unit_counts": dict(counts),
                "candidate_count": len(self._candidates[key]),
                "unlisted_count": len(doc["units"]) - len(self._candidates[key]),
            })
        page = self._range(start, len(candidates), _CATALOG_PAGE)
        return {"documents": documents, "candidates": candidates[start:start + _CATALOG_PAGE], **page}

    @staticmethod
    def _range(start, total, length):
        _check_start(start, total)
        end = min(start + length, total)
        return {
            "declared_range": [0, total], "returned_range": [start, end],
            "uncovered_ranges": [[a, b] for a, b in ((0, start), (end, total)) if a < b],
            "next_start": end if end < total else None,
        }

    def read(self, ref, start=0, columns=None):
        """Deliver source lines at stable offsets, optionally viewing specific source columns."""
        unit = self.units[ref]
        lines = unit["lines"]
        _check_start(start, len(lines))
        kind = unit["kind"]
        column_scope = None
        if columns is not None:
            valid = (kind == "pdf" and isinstance(columns, (list, tuple)) and len(columns) == 2
                     and all(type(n) is int for n in columns) and 0 <= columns[0] < columns[1])
            if not valid:
                raise ValueError("columns нужен для PDF и задаётся как [начало, конец) от 0")
            width = max(map(len, lines), default=0)
            if columns[0] >= width:
                raise ValueError(f"columns вне диапазона извлечённого текста [0, {width})")
            column_scope = self._range(columns[0], width, columns[1] - columns[0])
            column_scope.pop("next_start")
        left, right = columns if columns is not None else (None, None)
        rows = []
        raw_chars = content_chars = 0
        for i in range(start, min(start + _READ_ROWS, len(lines))):
            line = lines[i][left:right]
            raw_chars += len(line) + 55
            content_chars += len(" ".join(line.split())) + 24
            if rows and (raw_chars > _RAW_CHARS or content_chars > _CONTENT_CHARS):
                break
            row = {"ref": _ref(ref, i), "text": line}
            cad = _CAD_LINE.match(line) if kind.startswith("cad_") else None
            if cad:
                row["source_ref"] = cad[1]
            rows.append(row)

        headings, header_indices, continuations = self._signals[ref]
        context = sorted({j for i in header_indices[:12] for j in range(max(0, i - 2), min(len(lines), i + 3))})
        complete = self._range(start, len(lines), len(rows))
        end = complete["returned_range"][1]
        nearby = []
        if kind == "pdf" and "page" in unit:
            root = ref.partition(":")[0]
            nearby = [candidate for n in (unit["page"] - 1, unit["page"] + 1)
                      if (candidate := f"{root}:p{n}") in self.units]
        return {
            "ref": ref, "kind": kind, "title": unit["title"], "view_ref": self._view_ref(ref),
            "rows": rows, "columns": list(columns) if columns is not None else None, "adjacent_pages": nearby,
            "column_scope": column_scope, "text_layers": _text_layers(unit),
            "source_titles": headings[:8], "continuation_markers": continuations[:8],
            "header_refs": [_ref(ref, i) for i in header_indices[:12]],
            "header_context": [{"ref": _ref(ref, i), "text": lines[i][left:right]}
                               for i in context if not start <= i < end],
            **complete,
        }
