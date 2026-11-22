"""Generate new, entirely synthetic originals. Office packages use no macros."""

import io
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

ROOT = Path(__file__).parent / "fixtures"
ROOT.mkdir(exist_ok=True)
GOLD = Path(__file__).parent / "gold"
GOLD.mkdir(exist_ok=True)
NS = "http://schemas.openxmlformats.org"
W = NS + "/wordprocessingml/2006/main"
S = NS + "/spreadsheetml/2006/main"
R = NS + "/officeDocument/2006/relationships"
PKG = NS + "/package/2006/relationships"
CT = NS + "/package/2006/content-types"


def package(name, parts):
    with ZipFile(ROOT / name, "w") as zipped:
        for path, content in parts.items():
            zipped.writestr(ZipInfo(path), content.encode(), ZIP_DEFLATED)


def document_rel(target, kind):
    return f'<Relationships xmlns="{PKG}"><Relationship Id="rId1" Type="{R}/{kind}" Target="{target}"/></Relationships>'


def content_types(main, mime, others=""):
    return (f'<Types xmlns="{CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            f'<Default Extension="xml" ContentType="application/xml"/>'
            f'<Override PartName="/{main}" ContentType="application/vnd.openxmlformats-officedocument.{mime}"/>{others}</Types>')


def p(text, heading=False):
    style = '<w:pPr><w:pStyle w:val="Heading1"/><w:outlineLvl w:val="0"/></w:pPr>' if heading else ""
    return f"<w:p>{style}<w:r><w:t>{text}</w:t></w:r></w:p>"


def td(text, properties=""):
    return f"<w:tc><w:tcPr>{properties}</w:tcPr>{p(text)}</w:tc>"


grid = [
    '<w:tr><w:trPr><w:tblHeader/></w:trPr>'
    + td("Panel schedule", '<w:gridSpan w:val="2"/>') + td("Thickness, mm") + "</w:tr>",
    "<w:tr>" + td("Wing M", '<w:vMerge w:val="restart"/>') + td("AX-17 rev B") + td("2.40 mm") + "</w:tr>",
    "<w:tr>" + td("", "<w:vMerge/>") + td("AX-17 rev C") + td("2.80 mm") + "</w:tr>",
]
doc = (
    f'<w:document xmlns:w="{W}"><w:body>{p("Wing M", True)}'
    f'{p("Anchor family: RV-72.")}<w:p><w:commentRangeStart w:id="4"/><w:r><w:t>Finish code F-17</w:t>'
    '</w:r><w:commentRangeEnd w:id="4"/><w:r><w:commentReference w:id="4"/></w:r></w:p>'
    '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="1800"/><w:gridCol w:w="2800"/>'
    f'<w:gridCol w:w="2200"/></w:tblGrid>{"".join(grid)}</w:tbl><w:sectPr/></w:body></w:document>'
)
doc_types = (f'<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>')
package("schedule.docx", {
    "[Content_Types].xml": content_types("word/document.xml", "wordprocessingml.document.main+xml", doc_types),
    "_rels/.rels": document_rel("word/document.xml", "officeDocument"),
    "word/document.xml": doc,
    "word/_rels/document.xml.rels": document_rel("comments.xml", "comments"),
    "word/comments.xml": f'<w:comments xmlns:w="{W}"><w:comment w:id="4">{p("Finish requires sample.")}</w:comment></w:comments>',
})
package("unreadable.docx", {
    "word/document.xml": f'<!DOCTYPE w:document [<!ENTITY x SYSTEM "file:///outside">]><w:document xmlns:w="{W}"/>',
})


def s(ref, value):
    return f'<c r="{ref}" t="inlineStr"><is><t>{value}</t></is></c>'


rows = [
    f'<row r="1">{s("A1", "Wing M")}</row>',
    f'<row r="2">{s("A2", "Panel")}{s("B2", "Thickness, mm")}{s("C2", "Area, m2")}</row>',
    f'<row r="3">{s("A3", "AX-17 rev B")}<c r="B3" s="1"><v>2.400000000000003</v></c>'
    '<c r="C3"><f>B3*2</f><v>4.80</v></c></row>',
    f'<row r="4" hidden="1" outlineLevel="1">{s("A4", "AX-17 rev C")}<c r="B4" s="1"><v>2.8</v></c>'
    '<c r="C4"><f>B4*2</f></c></row>',
]
root_xlsx = {
    "[Content_Types].xml": content_types("xl/workbook.xml", "spreadsheetml.sheet.main+xml",
        '<Override PartName="/xl/worksheets/table.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/worksheets/empty.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'),
    "_rels/.rels": document_rel("xl/workbook.xml", "officeDocument"),
    "xl/workbook.xml": (f'<workbook xmlns="{S}" xmlns:r="{R}"><sheets><sheet name="Schedule M" sheetId="1" r:id="rId1"/>'
                        '<sheet name="Empty sheet" sheetId="2" r:id="rId2"/></sheets><calcPr fullCalcOnLoad="1"/></workbook>'),
    "xl/_rels/workbook.xml.rels": (f'<Relationships xmlns="{PKG}">'
                                  f'<Relationship Id="rId1" Type="{R}/worksheet" Target="worksheets/table.xml"/>'
                                  f'<Relationship Id="rId2" Type="{R}/worksheet" Target="/xl/worksheets/empty.xml"/>'
                                  f'<Relationship Id="rId3" Type="{R}/styles" Target="styles.xml"/></Relationships>'),
    "xl/worksheets/table.xml": (f'<worksheet xmlns="{S}"><sheetData>{"".join(rows)}</sheetData>'
                                '<mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells></worksheet>'),
    "xl/worksheets/empty.xml": f'<worksheet xmlns="{S}"><sheetData/></worksheet>',
    "xl/styles.xml": (f'<styleSheet xmlns="{S}"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.00 &quot;mm&quot;"/>'
                      '</numFmts><fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts>'
                      '<fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders>'
                      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
                      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
                      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>'),
}
package("schedule.xlsx", root_xlsx)
package("unreadable.xlsx", {key: value for key, value in root_xlsx.items() if key != "xl/worksheets/table.xml"})


def dxf(path, partial=False):
    pairs = []

    def put(*groups):
        pairs.extend(groups)

    put((0, "SECTION"), (2, "HEADER"), (9, "$ACADVER"), (1, "AC1015"), (0, "ENDSEC"))
    if partial:
        put((0, "SECTION"), (2, "TABLES"), (0, "TABLE"), (2, "STYLE"), (70, 1),
            (0, "STYLE"), (2, "MISSING"), (70, 0), (3, "fictional.shx"), (0, "ENDTAB"), (0, "ENDSEC"),
            (0, "SECTION"), (2, "BLOCKS"), (0, "BLOCK"), (2, "SYN-XREF"), (70, 4), (0, "ENDBLK"), (0, "ENDSEC"))
    put((0, "SECTION"), (2, "ENTITIES"))
    for handle, space, x, y, value in [
        ("30", "Model", 0, 80, "Wing M: Panel schedule"),
        ("31", "Model", 0, 70, "Panel | Assembly | Total"),
        ("32", "Model", 0, 60, "AX-17 rev B | 2 x 35 mm | 70 mm"),
        ("33", "Model", 0, 50, "AX-17 rev C | 5 x 14 mm | 70 mm"),
        ("34", "Model", 0, 40, "AX-71 rev B | 1 x 45 mm | 45 mm"),
        ("40", "Layout 1", 0, 70, "Wing M: Sheet title"),
    ]:
        put((0, "TEXT"), (5, handle), (100, "AcDbEntity"), (8, "0"), (67, int(space != "Model")), (410, space),
            (100, "AcDbText"), (10, x), (20, y), (30, 0), (40, 3), (1, value), (100, "AcDbText"))
    for n, y in enumerate([46, 56, 66], 0x51):
        put((0, "LINE"), (5, f"{n:X}"), (100, "AcDbEntity"), (8, "0"), (410, "Model"),
            (100, "AcDbLine"), (10, 0), (20, y), (30, 0), (11, 90), (21, y), (31, 0))
    put((0, "ENDSEC"), (0, "EOF"))
    (ROOT / path).write_text("".join(f"{k:3}\n{v}\n" for k, v in pairs), encoding="ascii")


dxf("schedule.dxf")
dxf("partial.dxf", partial=True)
(ROOT / "unreadable.dxf").write_text("  0\nSECTION\n  2\nENTITIES\n", encoding="ascii")

ifc = """ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('synthetic.ifc','2026-11-22T00:00:00',('Fixture'),('Fixture'),'synthetic','synthetic','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#11=IFCCARTESIANPOINT((0.,0.,0.));
#42=IFCWALL('0Xa1Bc2De3Fg4Hi5Jk6Lm7',$,'AX-17 rev B; Wing M',$,$,$,$,'AX-17',.STANDARD.);
#43=IFCWALL('0Xa1Bc2De3Fg4Hi5Jk6Lm8',$,'AX-17 rev C; Wing M',$,$,$,$,'AX-17',.STANDARD.);
#50=IFCPROPERTYSINGLEVALUE('Thickness',$,IFCLENGTHMEASURE(0.0024),$);
ENDSEC;
END-ISO-10303-21;
"""
(ROOT / "structure.ifc").write_text(ifc, encoding="ascii")
(ROOT / "unreadable.ifc").write_text(ifc.replace("#43=", "#42="), encoding="ascii")
(ROOT / "notes.txt").write_bytes("Wing M\r\nAX-17 rev B — 2.40 мм\r\nAX-17 rev C — 2.80 мм\r\n".encode())
(ROOT / "utf16.txt").write_bytes("Wing M\nТест — 2.4 мм".encode("utf-16"))
(ROOT / "unreadable.txt").write_bytes(bytes.fromhex("d2e5f1f2"))
(ROOT / "unreadable.doc").write_bytes(b"invalid synthetic Word binary\n")
(ROOT / "unreadable.xls").write_bytes(b"invalid synthetic Excel binary\n")
(ROOT / "unreadable.dwg").write_bytes(b"invalid synthetic drawing\n")
# The RVT fixture exercises intake-only coverage. It represents an unqualified opaque file.
(ROOT / "presence-only.rvt").write_bytes(b"synthetic opaque byte stream (RVT intake-only control)\n")
(ROOT / "presence-only.xyz").write_bytes(b"new unknown input\n")

pdf_file = ROOT / "mixed-raster.pdf"
pdf = canvas.Canvas(str(pdf_file), pagesize=(612, 792), invariant=True,
                    initialFontName="Helvetica")
pdf.setTitle("Synthetic mixed PDF qualification")

raster = Image.new("RGB", (1250, 500), "white")
draw = ImageDraw.Draw(raster)
font = ImageFont.load_default(size=48)
for offset, text in enumerate([
    "PANEL         THICKNESS mm",
    "ZX-582        8.65 mm",
    "ZX-528        8.95 mm",
]):
    draw.text((45, 55 + offset * 125), text, font=font, fill="black")
    draw.line((30, 135 + offset * 125, 1210, 135 + offset * 125), fill="black", width=3)

pdf.setFont("Helvetica-Bold", 16)
pdf.drawString(60, 726, "Wing M: mixed construction sheet")
pdf.drawImage(ImageReader(raster), 60, 270, 480, 192)
pdf.showPage()
pdf.setPageRotation(90)
pdf.drawImage(ImageReader(raster.rotate(90, expand=True)), 100, 115, 192, 480)
pdf.showPage()
pdf.setPageRotation(0)
noise = Image.new("RGB", (480, 192), "white")
low_contrast = ImageDraw.Draw(noise)
for line in range(15, 160, 5):
    low_contrast.line((10, line, 460, line + 7), fill=(180, 180, 180), width=4)
pdf.drawImage(ImageReader(noise), 60, 270, 480, 192)
pdf.showPage()
pdf.save()

(GOLD / "expected.json").write_text(json.dumps({
    "docx": {"table": 1, "row": 2, "column": 3, "text": "2.40 mm"},
    "xlsx": {"sheet": "Schedule M", "cell": "C3", "formula": "B3*2", "cachedValue": "4.80"},
    "dxf": {"space": "Model", "handle": "32", "text": "AX-17 rev B | 2 x 35 mm | 70 mm"},
    "ifc": {"step": "#42", "globalId": "0Xa1Bc2De3Fg4Hi5Jk6Lm7"},
    "pdf": {"page": 1, "box": {"x": 60, "y": 330, "width": 480, "height": 192},
            "text": "ZX-582", "value": "8.65 mm", "rotatedPage": 2, "unreadablePage": 3},
}, indent=2) + "\n")
