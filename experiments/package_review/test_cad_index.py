import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from cad_index import CadIndex, PAGE_SIZE


def _ref(handle):
    return [0,1,handle]


def _entry(kind, handle, **attrs):
    return {'object':kind, 'handle':_ref(handle), **attrs}


def _entity(kind, handle, **attrs):
    return {'entity':kind, 'handle':_ref(handle), **attrs}


def _write(directory, name, records):
    (directory / (name + '.json')).write_text(json.dumps(
        {'HEADER':{'BLOCK_RECORD_MSPACE':_ref(16)}, 'OBJECTS':records},
        ensure_ascii=False), encoding='utf-8')


class CadIndexTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name)
        geometry = [_entity('LINE',handle,layer=_ref(8),ownerhandle=_ref(16),start=[4,9])
                    for handle in range(128,128+PAGE_SIZE+2)]
        records = [
            _entry('LAYOUT',1,layout_name='Модель',tab_order=0,block_header=_ref(16)),
            _entry('LAYOUT',2,layout_name='Лист',tab_order=1,block_header=_ref(17)),
            _entry('LAYER',8,name='Аннотации'),
            _entry('LAYER',9,name='Контуры'),
            _entry('BLOCK_HEADER',16,name='*Model_Space',entities=[_ref(v) for v in (31,32,33,34,35)]),
            _entry('BLOCK_HEADER',17,name='*Paper_Space',entities=[_ref(48)]),
            _entry('BLOCK_HEADER',24,name='Определение',entities=[_ref(60)]),
            _entity('TEXT',31,layer=_ref(8),text_value='Краткая подпись'),
            _entity('MTEXT',32,layer=_ref(8),text=r'Первая\PВторая\PТретья'+'\tячейка'),
            _entity('INSERT',33,layer=_ref(9),block_header=_ref(24),attribs=[_ref(61)]),
            _entity('ACAD_TABLE',34,layer=_ref(8),num_rows=2,num_cols=1,
                    cells=[{'text':'Заголовок'},{'contents':[{'value':{'string':'Строка'}}]}]),
            _entity('MTEXT',35,layer=_ref(9),text='%<образец>%\nещё текст',xdicobjhandle=_ref(21)),
            _entry('DICTIONARY',21,ownerhandle=_ref(35),items={'ACAD_FIELD':_ref(70)}),
            _entry('FIELD',70,ownerhandle=_ref(21),field_code='формула'),
            _entry('TABLESTYLE',71,ownerhandle=_ref(99)),
            _entry('SECTIONVIEWSTYLE',72,viewlabel_pattern='%<пример>%'),
            _entity('ATTRIB',61,layer=_ref(8),text_value='Размещение с атрибутом'),
            _entity('MTEXT',48,layer=_ref(8),text='Листовая подпись'),
            _entity('MTEXT',60,layer=_ref(9),text='Внутри блока'),
            _entity('CIRCLE',81,layer=_ref(9),ownerhandle=_ref(82)),
            _entity('CIRCLE',82,layer=_ref(9),ownerhandle=_ref(81)),
            *geometry,
        ]
        _write(self.path, 'alpha', list(reversed(records)))
        _write(self.path, 'beta', [_entity('TEXT',31,text='Другой чертёж',entmode=2)])
        self.index = CadIndex.from_directory(self.path,{'d12':'beta.json','d4':'alpha.DWG'})

    def test_root_map_and_space_routes(self):
        overview = self.index.overview()
        self.assertLess(overview.index('cad/d4'),overview.index('cad/d12'))
        for ref in ('cad/d4/s1','cad/d4/s2','cad/d4/blocks','cad/d4/objects','cad/d4/unassigned'):
            self.assertIn(ref,overview)
        document = self.index.browse('cad/d4')
        for selector in ('multiline','structured','tables','table-support','fields','geometry'):
            self.assertIn(f'cad/d4/all/forms/{selector}',document)
        self.assertIn('cad/d4/all/paragraphs',document)
        self.assertIn('cad/d4/all/order/length',document)

    def test_layer_type_form_and_source_object(self):
        layer = self.index.browse('cad/d4/s1/layers')
        self.assertIn('cad/d4/s1/layers/l8 | Аннотации', layer)
        typed = self.index.browse('cad/d4/s1/layers/l8/types')
        self.assertIn('/types/MTEXT | 1',typed)
        cards = self.index.browse('cad/d4/s1/layers/l8/types/MTEXT/forms/multiline')
        self.assertIn('d4:h20 MTEXT',cards)
        self.assertIn('Первая ↵ Вторая ↵ Третья ⇥ ячейка',cards)
        self.assertEqual(self.index.source_ref('D4:H020'),'d4:h20')
        self.assertIn("read('d4:h20')", self.index.browse('d4:h20'))
        self.assertIn('Другой чертёж',self.index.browse('d12:h1f'))
        self.assertNotIn('d12:h1F',cards)

    def test_fields_and_tables_are_discoverable_separately(self):
        tables = self.index.browse('cad/d4/all/forms/tables')
        self.assertIn('d4:h22 ACAD_TABLE', tables)
        self.assertIn('2 строк, 1 столбцов', tables)
        self.assertIn('Заголовок | Строка', tables)
        self.assertNotIn('TABLESTYLE',tables)
        style = self.index.browse('cad/d4/all/forms/table-support')
        self.assertIn('d4:h47 TABLESTYLE',style)
        fields = self.index.browse('cad/d4/all/forms/fields')
        for marker in ('d4:h23 MTEXT','d4:h46 FIELD','d4:h15 DICTIONARY','d4:h48 SECTIONVIEWSTYLE'):
            self.assertIn(marker,fields)
        self.assertIn('словарь ACAD_FIELD у объекта',fields)
        self.assertIn('d4:h20 MTEXT',self.index.browse('cad/d4/all/forms/structured'))

    def test_blocks_insert_attributes_and_unresolved_ownership(self):
        block = self.index.browse('cad/d4/blocks/definitions')
        self.assertIn('cad/d4/b18 | Определение',block)
        self.assertIn('d4:h3C MTEXT',self.index.browse('cad/d4/b18/types/MTEXT'))
        self.assertIn('d4:h3D ATTRIB',self.index.browse('cad/d4/s1/types/ATTRIB'))
        self.assertIn('определение cad/d4/b18',self.index.browse('d4:h21'))
        self.assertIn('d4:h30 MTEXT',self.index.browse('cad/d4/s2/types/MTEXT'))
        self.assertIn('d4:h51 CIRCLE',self.index.browse('cad/d4/unassigned/types/CIRCLE'))

    def test_volume_navigation_and_stable_pagination(self):
        bins = self.index.browse('cad/d4/all/forms/multiline/paragraphs')
        self.assertIn('/paragraphs/2-3 | строк текста 2-3 | 2', bins)
        ordered = self.index.browse('cad/d4/all/forms/multiline/order/paragraphs')
        self.assertLess(ordered.index('d4:h20 MTEXT'),ordered.index('d4:h23 MTEXT'))
        by_length = self.index.browse('cad/d4/s1/types/MTEXT/order/length')
        self.assertIn('d4:h20 MTEXT',by_length)
        self.assertIn('Порядок: символов',by_length)
        ref = 'cad/d4/s1/types/LINE'
        first, second = self.index.browse(ref), self.index.browse(ref,PAGE_SIZE)
        self.assertIn(f'показано {PAGE_SIZE} из {PAGE_SIZE+2}',first)
        self.assertIn(f"Далее browse('{ref}', start={PAGE_SIZE})",first)
        self.assertIn('показано 2 из',second)
        self.assertNotIn('d4:h80 LINE',second)
        self.assertIn(f'd4:h{128+PAGE_SIZE:X} LINE',second)
        self.assertEqual(self.index.browse(ref),first)

    def test_mapping_and_input_validation(self):
        with self.assertRaises(ValueError):
            CadIndex.from_directory(self.path,{'d4':'../alpha'})
        with self.assertRaises(KeyError):
            self.index.source_ref('d4:hFFF')
        with self.assertRaises(ValueError):
            self.index.browse('cad/d4',True)
        with self.assertRaises(KeyError):
            self.index.browse('cad/d4/s1/order/unknown')


if __name__ == '__main__':
    unittest.main()
