"""Neutral, paged navigation of local LibreDWG JSON exports."""
from collections import Counter, defaultdict
from dataclasses import dataclass
import json
import math
from pathlib import Path
import re

PAGE_SIZE = 18
PREVIEW_SIZE = 145
_DRAWING_TABLES = {'TABLE', 'ACAD_TABLE'}
_TABLE_SUPPORT = {'TABLECONTENT', 'TABLEGEOMETRY', 'TABLESTYLE', 'CELLSTYLEMAP'}
_GEOMETRY = {
    '3DFACE', '3DSOLID', 'ARC', 'BODY', 'CIRCLE', 'ELLIPSE', 'HATCH', 'HELIX',
    'IMAGE', 'INSERT', 'LEADER', 'LINE', 'LWPOLYLINE', 'MESH', 'MINSERT', 'MLINE',
    'MPOLYGON', 'MULTILEADER',
    'POINT', 'RAY', 'REGION', 'SHAPE', 'SOLID', 'SPLINE', 'TRACE', 'WIPEOUT', 'XLINE',
}
_TEXT_KEYS = {'text', 'text_value', 'user_text', 'default_text', 'value_text'}
_FIELD_KEYS = {'field', 'fields', 'field_id', 'field_ids', 'field_code', 'fieldlist', 'field_list'}
_FORMS = {
    'text': 'текстовые записи',
    'multiline': 'текст с явными разрывами строк',
    'structured': 'текст с табуляцией, колонками или ячейками',
    'tables': 'табличные сущности TABLE / ACAD_TABLE',
    'table-support': 'вспомогательные записи таблиц и стилей',
    'fields': 'объекты, ссылки и синтаксические признаки полей',
    'geometry': 'геометрические сущности и размещения блоков',
}
_MEASURES = {'paragraphs': 'строк текста', 'length': 'символов в текстовых полях'}
_BINS = {
    'paragraphs': (0, 1, 3, 7, 15),
    'length': (0, 40, 120, 360, 1000),
}


def _bin(value, measure):
    previous = -1
    for upper in _BINS[measure]:
        if value <= upper:
            return str(upper) if previous + 1 == upper else f'{previous + 1}-{upper}'
        previous = upper
    return f'{previous + 1}+'


def _handle(value):
    if isinstance(value, list) and value and type(value[-1]) is int:
        return value[-1]
    return 0


def _kind(raw):
    return raw.get('entity') or raw.get('object') or 'UNKNOWN'


def _clip(text, limit):
    text = re.sub(r'[\x00-\x1f\x7f]+', ' ', str(text))
    return text if len(text) <= limit else text[:limit - 1] + '…'


def _point(raw):
    for key in ('ins_pt', 'ctx.content.txt.location', 'text_midpt', 'center', 'def_pt', 'start', 'point'):
        key_value = raw.get(key)
        if isinstance(key_value, list) and len(key_value) >= 2:
            x, y = key_value[:2]
            if all(type(n) in (int, float) and math.isfinite(n) for n in (x, y)):
                return f'{x:.6g},{y:.6g}'
    return ''


def _text_parts(record, in_cell=False):
    """Collect text in known value slots, including nested table cells."""
    if isinstance(record, list):
        for child in record:
            if isinstance(child, (dict, list)):
                yield from _text_parts(child,in_cell)
    elif isinstance(record, dict):
        for key, value in record.items():
            slot = key.rsplit('.',1)[-1]
            is_text = slot in _TEXT_KEYS or (in_cell and slot in ('value','string'))
            if isinstance(value,str) and is_text and value:
                yield value
            elif isinstance(value,(dict,list)):
                yield from _text_parts(value,in_cell or slot in ('cells','cell'))


def _has_field_syntax(value):
    if isinstance(value,str):
        return '%<' in value or '>%' in value
    if isinstance(value,dict):
        return any(_has_field_syntax(child) for child in value.values())
    if isinstance(value,list):
        return any(_has_field_syntax(child) for child in value)
    return False


def _field_dictionary(raw):
    items = raw.get('items')
    return isinstance(items,dict) and any(key.upper() == 'ACAD_FIELD' for key in items)


def _field_signals(raw):
    signals = []
    if _kind(raw) in ('FIELD', 'FIELDLIST'):
        signals.append('тип ' + _kind(raw))
    if _has_field_syntax(raw):
        signals.append('разметка %<…>%')
    keys = sorted(key for key, value in raw.items() if key.rsplit('.', 1)[-1] in _FIELD_KEYS and value)
    if keys:
        signals.append('ключи ' + ', '.join(keys))
    if _field_dictionary(raw):
        signals.append('словарь ACAD_FIELD')
    return signals


@dataclass(frozen=True, slots=True)
class _Card:
    handle: int
    kind: str
    space: str
    layer: int
    owner: int
    inserted_block: int
    point: str
    forms: tuple
    signals: tuple
    paragraphs: int
    length: int
    cells: str
    preview: str


@dataclass(slots=True)
class _Drawing:
    name: str
    cards: dict
    spaces: dict
    blocks: dict
    layers: dict
    by_space: dict


def _group_space(handle, raw, membership, owners, spaces, header):
    """Resolve storage ownership. INSERT occurrences are not multiplied."""
    current = handle
    visited = set()
    while current and current not in visited:
        visited.add(current)
        if current in spaces:
            return spaces[current]
        current = membership.get(current) or owners.get(current)
    if 'entity' in raw:
        if raw.get('entmode') == 2:
            return spaces.get(_handle(header.get('BLOCK_RECORD_MSPACE')), 'unassigned')
        return 'unassigned'
    return 'objects'


def _make_card(handle, raw, space, owner, raw_objects):
    kind = _kind(raw)
    is_text_container = 'entity' in raw or kind in _DRAWING_TABLES | _TABLE_SUPPORT | {'FIELD'}
    parts = tuple(_text_parts(raw)) if is_text_container else ()
    paragraphs = sum(1 + len(re.findall(r'\\P|\r\n|[\r\n]', text)) for text in parts)
    cells = raw.get('cells')
    nrows, ncols = raw.get('num_rows',raw.get('rows')),raw.get('num_cols',raw.get('columns'))
    axes = [f'{n} {label}' for n,label in ((nrows,'строк'),(ncols,'столбцов')) if type(n) is int]
    if isinstance(cells,list):
        axes.append(f'{len(cells)} записей cells')
    structure = any('\t' in value or r'\t' in value or r'\TAB' in value for value in parts)
    structure = structure or bool(cells) or any(raw.get(k, 0) for k in ('num_cols','column_count','ctx.content.txt.num_cols'))
    signals = _field_signals(raw)
    xdict = raw_objects.get(_handle(raw.get('xdicobjhandle')), {})
    if _field_dictionary(xdict):
        signals.append('словарь ACAD_FIELD у объекта')
    forms = []
    for form, has in (
        ('text', bool(parts)),
        ('multiline', paragraphs > len(parts)),
        ('structured', bool(parts) and structure),
        ('tables', kind in _DRAWING_TABLES),
        ('table-support', kind in _TABLE_SUPPORT),
        ('fields', bool(signals)),
        ('geometry', kind in _GEOMETRY or kind.startswith(('POLYLINE','VERTEX','DIMENSION'))),
    ):
        if has:
            forms.append(form)
    preview = ' | '.join(parts).replace(r'\P', ' ↵ ').replace('\r\n', ' ↵ ').replace('\n', ' ↵ ').replace('\r', ' ↵ ').replace('\t', ' ⇥ ')
    placed = _handle(raw.get('block_header')) if kind in ('INSERT','MINSERT') else 0
    return _Card(handle, kind, space, _handle(raw.get('layer')), owner, placed, _point(raw),
                 tuple(forms), tuple(signals), paragraphs, sum(map(len,parts)), ', '.join(axes),
                 _clip(preview, PREVIEW_SIZE))


def _load_drawing(path, name):
    parsed = json.loads(path.read_text(encoding='utf-8'))
    raw_objects = {}
    for raw in parsed['OBJECTS']:
        handle = _handle(raw.get('handle'))
        if not handle:
            raise ValueError('Запись LibreDWG без ненулевого handle')
        if handle in raw_objects:
            raise ValueError(f'Повтор handle {handle:X} в чертеже')
        raw_objects[handle] = raw

    owners = {h:_handle(raw.get('ownerhandle')) for h,raw in raw_objects.items()}
    membership = {}
    spaces, blocks, layers = {}, {}, {}
    storage_locations = {}
    layout_records = sorted(
        ((h,raw) for h,raw in raw_objects.items() if _kind(raw) == 'LAYOUT'),
        key=lambda item:(item[1].get('tab_order', 0), item[0]),
    )
    for handle, raw in layout_records:
        key = f's{handle:X}'
        spaces[key] = _clip(raw.get('layout_name', 'пространство'), 100)
        storage = _handle(raw.get('block_header'))
        if storage:
            storage_locations.setdefault(storage,key)
        storage_locations[handle] = key

    for handle in sorted(raw_objects):
        raw = raw_objects[handle]
        kind = _kind(raw)
        if kind == 'LAYER':
            layers[handle] = _clip(raw.get('name', 'слой'), 100)
        if kind == 'BLOCK_HEADER':
            label = raw.get('name', 'блок')
            if handle not in storage_locations:
                if re.fullmatch(r'\*(?:model|paper)_space\d*', label, re.I):
                    key = f's{handle:X}'
                    spaces[key] = _clip(label,100)
                else:
                    key = f'b{handle:X}'
                    blocks[key] = _clip(label,100)
                storage_locations[handle] = key
            for child in raw.get('entities', []):
                child_handle = _handle(child)
                if child_handle:
                    membership.setdefault(child_handle, handle)
        if kind in ('INSERT', 'MINSERT'):
            for child in raw.get('attribs', []):
                child_handle = _handle(child)
                if child_handle:
                    membership.setdefault(child_handle,handle)

    cards = {}
    by_space = defaultdict(list)
    for handle in sorted(raw_objects):
        raw = raw_objects[handle]
        space = _group_space(handle, raw, membership, owners, storage_locations, parsed.get('HEADER',{}))
        owner = membership.get(handle) or owners[handle]
        card = _make_card(handle, raw, space, owner, raw_objects)
        cards[handle] = card
        by_space[space].append(card)
    return _Drawing(name, cards, spaces, blocks, layers, dict(by_space))


def _summary(cards):
    counts = Counter(form for card in cards for form in card.forms)
    forms = ', '.join(f'{form}={counts[form]}' for form in _FORMS)
    layers = len({card.layer for card in cards if card.layer})
    kinds = len({card.kind for card in cards})
    return f'записей {len(cards)}, слоёв {layers}, типов {kinds} | {forms}'


def _page(title, rows, ref, start, details=(), render=str):
    if type(start) is not int or not 0 <= start <= len(rows):
        raise ValueError(f'start должен быть от 0 до {len(rows)}')
    end = min(len(rows),start + PAGE_SIZE)
    lines = [f'{title} | показано {end-start} из {len(rows)}, start={start}; вне ответа {len(rows)-(end-start)}',
             *details, *(render(row) for row in rows[start:end])]
    if end < len(rows):
        lines.append(f'Далее browse({ref!r}, start={end})')
    if start:
        lines.append(f'Ранее browse({ref!r}, start={max(0,start-PAGE_SIZE)})')
    return '\n'.join(lines)


class CadIndex:
    """Shared immutable catalogue. The caller owns coverage between requests."""

    def __init__(self, drawings):
        self._drawings = drawings

    @classmethod
    def from_directory(cls, path, mapping):
        """Read <basename>.json for each dN in the caller-supplied mapping."""
        directory = Path(path)
        drawings = {}
        for doc, basename in mapping.items():
            if not isinstance(doc,str) or not re.fullmatch(r'd[1-9][0-9]*',doc):
                raise ValueError('Ключ mapping должен иметь вид dN')
            basename = str(basename)
            if Path(basename).name != basename or basename in ('.','..'):
                raise ValueError('В mapping ожидается имя файла без каталога')
            stem = Path(basename).stem if Path(basename).suffix.lower() in ('.dwg','.json') else basename
            drawings[doc] = _load_drawing(directory / (stem + '.json'), stem)
        return cls(dict(sorted(drawings.items(), key=lambda item: int(item[0][1:]))))

    def overview(self):
        """Show every drawing and give equal entry points to its spaces and groups."""
        lines = ['CAD | каталог записей локального разбора DWG.',
                 'browse("cad/<документ>") → пространства; далее layers, types и forms. '
                 'В карточках объектов <документ>:hHEX → исходная запись. '
                 'paragraphs и length группируют записи по объёму текста.',
                 'Счётчики отражают записи DWG, включая служебные. Формы пересекаются. '
                 'Нуль относится к разобранным записям. Покрытие листа проверяется отдельно.']
        for doc, drawing in self._drawings.items():
            root = f'cad/{doc}'
            lines.append(f'{root} | {_summary(list(drawing.cards.values()))}')
            for key, label in list(drawing.spaces.items())[:6]:
                lines.append(f'  {root}/{key} | {label} | {_summary(drawing.by_space.get(key,[]))}')
            extra = max(0,len(drawing.spaces)-6)
            if extra:
                lines.append(f'  Ещё пространств: {extra} → {root}')
            lines.append(f'  {root}/all (сводно) · {root}/blocks (определений {len(drawing.blocks)}) · '
                         f'{root}/objects (записей {len(drawing.by_space.get("objects",[]))}) · '
                         f'{root}/unassigned (записей {len(drawing.by_space.get("unassigned",[]))})')
        return '\n'.join(lines)

    def source_ref(self, ref):
        """Validate and normalize a reader-native source pointer."""
        match = re.fullmatch(r'(d[1-9][0-9]*):h([0-9a-f]+)',ref,re.I)
        if match is None:
            raise ValueError('Ожидается исходная ссылка <документ>:hHEX')
        doc, handle = match[1].lower(), int(match[2],16)
        if doc not in self._drawings or handle not in self._drawings[doc].cards:
            raise KeyError(ref)
        return f'{doc}:h{handle:X}'

    def _card_row(self, doc, drawing, card, full=False):
        label = drawing.layers.get(card.layer,f'0x{card.layer:X}') if card.layer else 'без слоя'
        parts = [f'{doc}:h{card.handle:X} {card.kind}', f'слой {label}',
                 f'место cad/{doc}/{card.space}']
        if card.point:
            parts.append('локальные XY '+card.point)
        if card.forms:
            parts.append(', '.join(card.forms))
        if card.paragraphs:
            parts.append(f'строк текста {card.paragraphs}, символов {card.length}')
        if card.cells:
            parts.append(card.cells)
        if card.signals:
            parts.append('; '.join(card.signals))
        if card.preview:
            parts.append(card.preview)
        if card.inserted_block:
            location = f'cad/{doc}/b{card.inserted_block:X}'
            target = location if f'b{card.inserted_block:X}' in drawing.blocks else f'{doc}:h{card.inserted_block:X}'
            parts.append(f'определение {target}')
        if full and card.owner:
            parts.append(f'владелец/контейнер {doc}:h{card.owner:X}')
        return ' | '.join(parts)

    def _space_members(self, drawing, scope):
        if scope == 'all':
            return list(drawing.cards.values())
        if scope == 'blocks':
            return [card for block in drawing.blocks for card in drawing.by_space.get(block,[])]
        if scope in drawing.spaces or scope in drawing.blocks or scope in ('objects','unassigned'):
            return drawing.by_space.get(scope,[])
        raise KeyError(scope)

    def _groups(self, drawing, cards, selector, title):
        if selector == 'layers':
            counts = Counter(card.layer for card in cards)
            return [f'{title}/l{h:X} | {drawing.layers.get(h, f"0x{h:X}") if h else "без слоя"} | {n}'
                    for h,n in sorted(counts.items())]
        if selector == 'types':
            counts = Counter(card.kind for card in cards)
            return [f'{title}/{kind} | {n}' for kind,n in sorted(counts.items())]
        if selector == 'forms':
            counts = Counter(form for card in cards for form in card.forms)
            return [f'{title}/{form} | {label} | {counts[form]}' for form,label in _FORMS.items()]
        counts = Counter(_bin(getattr(card,selector),selector) for card in cards)
        groups = [_bin(upper,selector) for upper in _BINS[selector]]
        groups.append(_bin(_BINS[selector][-1]+1,selector))
        return [f'{title}/{group} | {_MEASURES[selector]} {group} | {counts[group]}' for group in groups]

    def _filtered(self, cards, selector, value):
        if selector == 'layers':
            if not re.fullmatch(r'l[0-9A-Fa-f]+',value):
                raise KeyError(value)
            handle = int(value[1:],16)
            return [card for card in cards if card.layer == handle]
        if selector == 'types':
            return [card for card in cards if card.kind == value]
        if selector in _MEASURES:
            return [card for card in cards if _bin(getattr(card,selector),selector) == value]
        if value in _FORMS:
            return [card for card in cards if value in card.forms]
        raise KeyError(value)

    def browse(self, ref='cad', start=0):
        """Browse group counts, use cumulative selectors, or inspect an object card."""
        if not isinstance(ref,str):
            raise ValueError('Ссылка должна быть строкой')
        if ':' in ref:
            source = self.source_ref(ref)
            doc, part = source.split(':')
            drawing = self._drawings[doc]
            card = drawing.cards[int(part[1:],16)]
            return _page(source, [self._card_row(doc,drawing,card,True),
                                  f'Исходная запись: read({source!r})'], source, start)
        path = ref.strip('/').split('/')
        if path[0] != 'cad':
            raise KeyError(ref)
        if len(path) == 1:
            rows = [f'cad/{doc} | {_summary(list(drawing.cards.values()))}' for doc,drawing in self._drawings.items()]
            return _page('DWG в каталоге',rows,ref,start)
        doc = path[1]
        drawing = self._drawings[doc]
        root = f'cad/{doc}'
        if len(path) == 2:
            spaces = [('all','все записи'),*drawing.spaces.items(),('blocks','определения блоков'),
                      ('objects','служебные записи без пространства'),('unassigned','сущности без установленного пространства')]
            rows = [f'{root}/{s} | {name} | {_summary(self._space_members(drawing,s))}' for s,name in spaces]
            forms = self._groups(drawing,list(drawing.cards.values()),'forms',f'{root}/all/forms')
            details = ['Формы записей во всём чертеже:',*forms,
                       f'Распределение: {root}/all/paragraphs · {root}/all/length',
                       f'Сортировка: {root}/all/order/paragraphs · {root}/all/order/length']
            return _page(f'{root} | пространства и области хранения',rows,ref,start,details)
        scope = path[2]
        if path[2:] == ['blocks','definitions']:
            rows = [f'{root}/{key} | {name} | {_summary(drawing.by_space.get(key,[]))}'
                    for key,name in drawing.blocks.items()]
            return _page(f'{root} | определения блоков',rows,ref,start)
        cards = self._space_members(drawing,scope)
        prefix = f'{root}/{scope}'
        selectors = ('layers', 'types', 'forms', *_MEASURES)
        selected = set()
        order = None
        suffix = path[3:]
        if len(suffix) >= 2 and suffix[-2] == 'order':
            order = suffix[-1]
            if order not in _MEASURES or len(suffix) % 2:
                raise KeyError(ref)
            path = path[:-2]
        for i in range(3,len(path),2):
            selector = path[i]
            if selector not in selectors or selector in selected:
                raise KeyError(ref)
            if i == len(path)-1:
                return _page(f'{prefix}/{selector} | {_summary(cards)}',
                             self._groups(drawing,cards,selector,f'{prefix}/{selector}'),ref,start)
            selected.add(selector)
            value = path[i+1]
            cards = self._filtered(cards,selector,value)
            prefix += f'/{selector}/{value}'
        links = [f'{prefix}/{s}' for s in selectors if s not in selected]
        if scope == 'blocks' and not selected:
            links.append(f'{prefix}/definitions')
        if scope == 'all':
            links.append(root)
        order_links = [f'{prefix}/order/{measure}' for measure in _MEASURES]
        details = ['Группы: '+' · '.join(links)] if links else []
        details.append('Сортировка: '+' · '.join(order_links))
        if order:
            cards = sorted(cards,key=lambda card:(-getattr(card,order),card.handle))
            details.append(f'Порядок: {_MEASURES[order]} по убыванию, затем handle.')
        if not selected and not order:
            return _page(f'{prefix} | {_summary(cards)}',links + order_links,ref,start,
                         ['Выберите слой, тип, физический признак или объём текста.'])
        return _page(f'{prefix} | {_summary(cards)}',cards,ref,start,details,
                     render=lambda card: self._card_row(doc,drawing,card))
