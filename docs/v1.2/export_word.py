"""Render the canonical Facade AI 1.2 Markdown into a reproducible Word file."""

import argparse
from hashlib import sha256
from html import unescape
from io import BytesIO
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlsplit
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.opc.constants import RELATIONSHIP_TYPE
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

SOURCE = Path(__file__).with_name("Facade-AI-Specification-1.2.md")
REPO = SOURCE.parents[2]
OUTPUT = SOURCE.with_suffix(".docx")


def markdown_tokens(source):
    return json.loads(
        subprocess.check_output([
            os.environ.get("FACADE_DOC_NODE", "node"), "-e",
            'const m = require(process.argv[1]);'
            'const md = require("fs").readFileSync(0, "utf8");'
            'process.stdout.write(JSON.stringify(m.lexer(md)));',
            os.environ.get("FACADE_DOC_MARKED", "marked"),
        ], input=source)
    )


def heading_anchor(text):
    return re.sub(r"[^\w -]", "", text.lower()).replace(" ", "-")


def bookmark(anchor):
    return "section_" + sha256(anchor.encode()).hexdigest()[:24]


def element(tag, **attrs):
    node = OxmlElement("w:" + tag)
    for key, value in attrs.items():
        node.set(qn("w:" + key), str(value))
    return node


def local_link(source, href):
    target = urlsplit(href)
    if target.scheme or target.netloc:
        return
    path = (source.parent / unquote(target.path)).resolve() if target.path else source
    if not path.is_relative_to(REPO.resolve()) or not path.exists():
        raise ValueError(f"{source.name}: broken local link {href}")
    if target.fragment:
        headings = re.findall(r"^#{1,6} (.+)$", path.read_text(), re.M)
        if unquote(target.fragment) not in {heading_anchor(title) for title in headings}:
            raise ValueError(f"{source.name}: missing heading in {href}")


def render_inline(paragraph, tokens, container=None, text_style=None):
    for token in tokens:
        kind = token["type"]
        if kind in ("text", "escape", "codespan"):
            value = token["text"]
            if kind == "text":
                value = unescape(value)
            run = paragraph.add_run(value, style=text_style)
            if kind == "codespan":
                run.font.name = "Liberation Mono"
                run.font.size = Pt(9)
            if container is not None:
                container.append(run._element)
        elif kind in ("strong", "em"):
            render_inline(
                paragraph, token["tokens"], container,
                "Strong" if kind == "strong" else "Emphasis",
            )
        elif kind == "link":
            href = token["href"]
            local_link(SOURCE, href)
            link = element("hyperlink")
            if href.startswith("#"):
                link.set(qn("w:anchor"), bookmark(unquote(href[1:])))
            else:
                rel = paragraph.part.relate_to(href, RELATIONSHIP_TYPE.HYPERLINK, is_external=True)
                link.set(qn("r:id"), rel)
            paragraph._p.append(link)
            render_inline(paragraph, token["tokens"], link, "Spec Link")
        else:
            raise ValueError(f"Unsupported inline Markdown token {kind}")


def document_style(document):
    page = document.sections[0]
    page.page_height, page.page_width = Cm(29.7), Cm(21)
    page.top_margin, page.bottom_margin = Cm(1.8), Cm(1.8)
    page.left_margin, page.right_margin = Cm(2), Cm(2)
    for style in ("Normal", "Title", "Heading 1", "Heading 2", "Heading 3"):
        document.styles[style].font.name = "Liberation Sans"
    document.styles["Normal"].font.size = Pt(10)
    document.styles["Normal"].paragraph_format.space_after = Pt(5)
    document.styles["Normal"].paragraph_format.line_spacing = 1.08
    title = document.styles["Title"]
    title.font.size = Pt(23)
    title.paragraph_format.keep_with_next = True
    properties = title._element.get_or_add_pPr()
    border = properties.find(qn("w:pBdr"))
    if border is not None:
        properties.remove(border)
    link = document.styles.add_style("Spec Link", WD_STYLE_TYPE.CHARACTER)
    link.font.color.rgb = RGBColor.from_string("1C5B85")
    link.font.underline = True


def render_table(document, token):
    header = token["header"]
    table = document.add_table(rows=0, cols=len(header), style="Light Shading Accent 1")
    table.autofit = False
    widths = [5.2, 11.8] if len(header) == 2 else [3.4, 5.0, 8.6]
    if [cell["text"] for cell in header] == ["ID", "Решение", "Принятый вариант"]:
        widths = [1.2, 4.4, 11.4]
    if header[0]["text"] == "Нагрузка":
        widths = [4.4, 4.0, 8.6]
    if header[0]["text"] == "Шаг":
        widths = [1.3, 15.7]
    if len(header) != len(widths):
        raise ValueError("Unsupported table width")
    for column, width in zip(table.columns, widths, strict=True):
        column.width = Cm(width)
    for row_no, row in enumerate([header, *token["rows"]]):
        word_row = table.add_row()
        properties = word_row._tr.get_or_add_trPr()
        properties.append(element("cantSplit"))
        if row_no == 0:
            properties.append(element("tblHeader"))
        for cell, markdown_cell, width in zip(word_row.cells, row, widths, strict=True):
            paragraph = cell.paragraphs[0]
            paragraph.paragraph_format.space_after = Pt(3)
            if row_no == 0:
                paragraph.paragraph_format.keep_with_next = True
            cell.width = Cm(width)
            render_inline(paragraph, markdown_cell["tokens"], text_style="Strong" if row_no == 0 else None)
    document.add_paragraph().paragraph_format.space_after = Pt(0)


def render_list(document, token):
    for number, item in enumerate(token["items"], token["start"] or 1):
        paragraph = document.add_paragraph(style="List Bullet" if not token["ordered"] else "Normal")
        if token["ordered"]:
            paragraph.paragraph_format.left_indent = Cm(0.62)
            paragraph.paragraph_format.first_line_indent = Cm(-0.62)
            paragraph.add_run(f"{number}.\t")
        for block in item["tokens"]:
            if block["type"] != "text":
                raise ValueError(f"Unsupported list block {block['type']}")
            render_inline(paragraph, block["tokens"])


def word_bytes(source):
    document = Document()
    document_style(document)
    document.core_properties.author = "Facade AI"
    document.core_properties.title = "Facade AI — спецификация продукта 1.2"
    document.core_properties.subject = "Требования для разработки и приёмки"
    document.core_properties.comments = f"SHA-256 Markdown: {sha256(source).hexdigest()}"

    for number, token in enumerate(markdown_tokens(source)):
        kind = token["type"]
        if kind == "heading":
            depth = token["depth"]
            paragraph = document.add_heading(level=depth - 1)
            label = bookmark(heading_anchor(token["text"]))
            paragraph._p.append(element("bookmarkStart", id=number, name=label))
            render_inline(paragraph, token["tokens"])
            paragraph._p.append(element("bookmarkEnd", id=number))
        elif kind == "paragraph":
            render_inline(document.add_paragraph(), token["tokens"])
        elif kind == "table":
            render_table(document, token)
        elif kind == "list":
            render_list(document, token)
        elif kind == "code":
            run = document.add_paragraph().add_run(token["text"])
            run.font.name, run.font.size = "Liberation Mono", Pt(9)
        elif kind != "space":
            raise ValueError(f"Unsupported Markdown block {kind}")

    saved = BytesIO()
    document.save(saved)
    # Fix the archive's timestamps so --check can compare the actual delivery bytes.
    result = BytesIO()
    with ZipFile(saved) as original, ZipFile(result, "w") as stable:
        for name in original.namelist():
            stable.writestr(ZipInfo(name, (2026, 11, 24, 0, 0, 0)), original.read(name), ZIP_DEFLATED)
    return result.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check links and compare the committed Word file")
    args = parser.parse_args()
    word = word_bytes(SOURCE.read_bytes())
    if args.check:
        if word != OUTPUT.read_bytes():
            raise SystemExit(f"{OUTPUT.name} differs from the canonical Markdown export")
        print(f"OK: {SOURCE.name} → {OUTPUT.name}, SHA-256 {sha256(word).hexdigest()}")
    else:
        OUTPUT.write_bytes(word)


if __name__ == "__main__":
    main()
