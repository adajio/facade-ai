import unittest

from schedule_reader import ScheduleReader


def unit(kind, title, lines, **metadata):
    return {"kind": kind, "title": title, "lines": lines, **metadata}


def documents(units, *entries):
    return {ref: {"name": name, "format": kind, "units": [key for key in units if key.startswith(ref + ":")]}
            for ref, name, kind in entries}


class ScheduleReaderTest(unittest.TestCase):
    def setUp(self):
        self.rows = [
            "                            Количество    Масса",
            "  Поз.  Обозначение  Наименование          Примечание",
            "                            Север   Юг    Всего",
            "  М12   образец А           7       2     9              рисунок справа",
            "        примечание об исполнении А",
            "  М12б  образец Б           —       4     4              размер 500",
            "        итог по группе                    13",
        ]
        self.units = {
            "d1:p1": unit("pdf", "Страница 1 (оригинал PDF; текстовый слой)", self.rows, page=1),
            "d1:p2": unit("pdf", "Страница 2 (оригинал PDF; текстовый слой)",
                          ["Ведомость деталей (продолжение)", "  Q7    крышка     6"], page=2),
            "d1:p3": unit("pdf", "Страница 3 (оригинал PDF; текст отсутствует)",
                          ["[Текстовый слой пуст]"], page=3),
            "d2:g1": unit("cad_group", "Пространство Лист", ["Границы XY"], views=["d2:v42"]),
            "d2:v42": unit("cad_view", "Вид модели", ["d2:h7A MTEXT фасад | xy=2.000,3.000"]),
            "d2:g2": unit("cad_index", "Все текстовые объекты", [
                "d2:hFE MTEXT Ведомость деталей | xy=1.000,2.000 | блок A2",
                "d2:hAB MTEXT Плита | 7 | 2 | xy=1.100,2.000 | блок A2",
            ]),
            "d3:s1": unit("word", "document.xml / таблица / элемент 4", ["01 | Держатель | 21"]),
            "d3:i1": unit("image", "Вложенное PNG", ["[Растровое изображение. Доступно через view.]"]),
            "d4:s1": unit("word", "document.xml / абзац / элемент 1", ["Согласованные сроки"]),
        }
        self.docs = documents(self.units, ("d1", "чертёж.pdf", "PDF"), ("d2", "узел.dwg", "DWG"),
                              ("d3", "описание.docx", "DOCX"), ("d4", "письмо.doc", "DOC"))
        self.reader = ScheduleReader(self.docs, self.units)

    def test_catalog_uses_source_order_addresses_and_all_document_names(self):
        page = self.reader.catalog()
        self.assertEqual([doc["ref"] for doc in page["documents"]], list(self.docs))
        expected = [ref for ref in self.units if ref not in ("d2:v42", "d4:s1")]
        self.assertEqual([item["ref"] for item in page["candidates"]], expected)
        first = page["candidates"][0]
        self.assertEqual(first["signals"], ["column_header"])
        self.assertEqual(first["header_refs"], ["d1:p1#L0", "d1:p1#L1"])
        self.assertNotIn("М12", repr(page))
        self.assertEqual(page["documents"][-1]["candidate_count"], 0)
        self.assertEqual(page["documents"][-1]["unlisted_count"], 1)

    def test_catalog_paginates_without_gaps_or_selected_doc_leaking(self):
        refs = [f"d1:p{i}" for i in range(1, 76)]
        units = {ref: unit("pdf", "Страница", ["Ведомость крепежа"]) for ref in refs}
        units["d2:p1"] = unit("pdf", "Страница", ["Schedule of brackets"])
        docs = documents(units, ("d1", "A.pdf", "PDF"), ("d2", "B.pdf", "PDF"))
        reader = ScheduleReader(docs, units)
        start = 0
        found = []
        while start is not None:
            page = reader.catalog(start, doc_ref="d1")
            self.assertEqual(page["returned_range"][0], start)
            self.assertEqual(page["declared_range"], [0, len(refs)])
            self.assertEqual(len(page["documents"]), 1)
            found.extend(item["ref"] for item in page["candidates"])
            start = page["next_start"]
        self.assertEqual(found, refs)
        self.assertEqual(reader.catalog(doc_ref="d2")["candidates"][0]["ref"], "d2:p1")

    def test_whole_sheet_preserves_source_rows_including_spaces_and_wrapping(self):
        result = self.reader.read("d1:p1")
        self.assertEqual(result["rows"], [{"ref": f"d1:p1#L{i}", "text": row} for i, row in enumerate(self.rows)])
        self.assertEqual(result["declared_range"], [0, len(self.rows)])
        self.assertEqual(result["returned_range"], [0, len(self.rows)])
        self.assertEqual(result["uncovered_ranges"], [])
        self.assertEqual(result["header_context"], [])
        self.assertIsNone(result["next_start"])
        self.assertEqual(result["view_ref"], "d1:p1")

    def test_column_projection_is_explicit_and_keeps_original_row_refs(self):
        result = self.reader.read("d1:p1", columns=(3, 19))
        self.assertEqual(result["columns"], [3, 19])
        self.assertEqual(result["column_scope"]["uncovered_ranges"], [[0, 3], [19, max(map(len, self.rows))]])
        self.assertEqual(result["rows"][4], {"ref": "d1:p1#L4", "text": self.rows[4][3:19]})
        self.assertEqual(self.reader.read("d1:p1")["rows"][4]["text"], self.rows[4])

    def test_pagination_preserves_text_and_repeats_header_as_context(self):
        original = [self.rows[1]] + [f"  Y{i}  опора  {i}" for i in range(700)]
        units = {"d1:p1": unit("pdf", "Страница", original)}
        reader = ScheduleReader(documents(units, ("d1", "A.pdf", "PDF")), units)
        first = reader.read("d1:p1")
        next_start = first["next_start"]
        self.assertGreater(next_start, 0)
        self.assertEqual(first["uncovered_ranges"], [[next_start, len(original)]])
        second = reader.read("d1:p1", start=next_start)
        self.assertEqual(second["header_context"][0], {"ref": "d1:p1#L0", "text": original[0]})
        self.assertIn([0, next_start], second["uncovered_ranges"])
        self.assertEqual(second["rows"][0]["ref"], f"d1:p1#L{next_start}")
        found = list(first["rows"])
        while next_start is not None:
            page = reader.read("d1:p1", start=next_start)
            found.extend(page["rows"])
            next_start = page["next_start"]
        self.assertEqual([r["text"] for r in found], original)
        self.assertEqual([r["ref"] for r in found], [f"d1:p1#L{i}" for i in range(len(original))])

    def test_an_oversized_first_row_is_neither_cut_nor_repeated(self):
        long_row = "  " + "слово " * 16_000
        units = {"d1:p1": unit("pdf", "Страница", [long_row, "конец"])}
        reader = ScheduleReader(documents(units, ("d1", "A.pdf", "PDF")), units)
        first = reader.read("d1:p1")
        self.assertEqual(first["rows"], [{"ref": "d1:p1#L0", "text": long_row}])
        self.assertEqual(first["next_start"], 1)
        self.assertEqual(reader.read("d1:p1", 1)["rows"], [{"ref": "d1:p1#L1", "text": "конец"}])

    def test_continuation_marker_and_adjacent_pages_remain_addressable(self):
        result = self.reader.read("d1:p2")
        self.assertEqual(result["adjacent_pages"], ["d1:p1", "d1:p3"])
        self.assertEqual(result["continuation_markers"], [
            {"row_ref": "d1:p2#L0", "text": "Ведомость деталей (продолжение)"},
        ])
        self.assertEqual(result["rows"][-1]["text"], "  Q7    крышка     6")

    def test_source_notes_ocr_and_visual_navigation_are_labelled(self):
        raster = self.reader.read("d1:p3")
        self.assertEqual(raster["view_ref"], "d1:p3")
        self.assertEqual(raster["text_layers"], [{"source": "reader_note", "range": [0, 1]}])
        self.assertEqual(self.reader.read("d3:i1")["view_ref"], "d3:i1")
        self.assertIsNone(self.reader.read("d3:s1")["view_ref"])
        units = {"d1:p1": unit("pdf", "Страница (текстовый слой/OCR)", [
            "Нативный текст", "[Дополнение OCR rus+eng, проверить на изображении]", "Растровый текст",
        ])}
        reader = ScheduleReader(documents(units, ("d1", "A.pdf", "PDF")), units)
        self.assertEqual(reader.read("d1:p1")["text_layers"], [
            {"source": "pdf_text_layer", "range": [0, 1]}, {"source": "reader_note", "range": [1, 2]},
            {"source": "pdf_ocr", "range": [2, 3]},
        ])

    def test_dwg_rows_keep_native_handles_and_expose_viewports(self):
        page = self.reader.catalog(doc_ref="d2")
        group, index = page["candidates"]
        self.assertEqual(group["viewports"], ["d2:v42"])
        self.assertEqual(group["view_ref"], "d2:g1")
        self.assertEqual(index["source_titles"][0]["source_ref"], "d2:hFE")
        self.assertIsNone(index["view_ref"])
        self.assertEqual(self.reader.read("d2:g2")["rows"][1]["source_ref"], "d2:hAB")
        self.assertEqual(self.reader.read("d2:v42")["view_ref"], "d2:v42")

    def test_invalid_address_or_pagination_keeps_the_reader_usable(self):
        with self.assertRaises(KeyError):
            self.reader.read("d1:p404")
        for start in (-1, True, "2", 99):
            with self.subTest(start=start), self.assertRaises(ValueError):
                self.reader.read("d1:p1", start=start)
        with self.assertRaises(ValueError):
            self.reader.catalog(-1)
        with self.assertRaises(ValueError):
            self.reader.read("d1:p1", columns=[500, 700])
        with self.assertRaises(ValueError):
            self.reader.read("d3:s1", columns=[0, 2])
        self.assertEqual(self.reader.read("d1:p1")["rows"][0]["text"], self.rows[0])
        self.assertIsNone(self.reader.read("d1:p1", len(self.rows))["next_start"])


if __name__ == "__main__":
    unittest.main()
