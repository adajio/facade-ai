"""Compare saved primary events to sealed PDF/XLSX addresses without model calls."""
from collections import Counter
import json
from pathlib import Path
import runpy
import sys


fixture = runpy.run_path(str(Path(__file__).with_name('verify-fixtures.py')))


def norm(text):
    return ' '.join(text.split()).casefold() if isinstance(text, str) else ''


def items(observation):
    yield observation
    yield from observation.get('components', [])


def score(root, snapshot_path, continuation=False):
    oracle = json.loads((root / 'verifier' / 'oracle.json').read_text())
    originals = {Path(entry['path']).name: (entry['sha256'], root / entry['path']) for entry in
                 json.loads((root / 'verifier' / 'manifest.json').read_text())['originals']}
    assert fixture['digest'](root / 'verifier' / 'oracle.json') == json.loads(
        (root / 'verifier' / 'manifest.json').read_text())['oracleSha256']
    data = json.loads(snapshot_path.read_text())
    if continuation:
        assert data['phase'] == 'continuation' and data['helper']
    else:
        assert data['phase'] == 'primary' and data['helper'] == []
    expected = oracle['expected']
    groups = {kind: list(fixture['supports'](expected[kind])) for kind in ('crossQuestion', 'falseConflicts', 'letter')}
    known_pdf = {name: fixture['native_pdf'](path) for name, (_, path) in originals.items() if path.suffix == '.pdf'}
    known_xlsx = {name: fixture['native_cells'](path) for name, (_, path) in originals.items() if path.suffix == '.xlsx'}

    def match(anchor, source_hash, location, quote):
        if source_hash != originals[anchor['file']][0] or len(norm(quote)) < 3:
            return False
        if 'page' in anchor:
            literal = known_pdf[anchor['file']][anchor['page'] - 1][anchor['line'] - 1]
            return location.get('page') == anchor['page'] and norm(quote) in norm(literal)
        cell = location.get('cell')
        return (location.get('sheet') == anchor['sheet'] and cell in anchor['cells'] and
                norm(quote) in norm(known_xlsx[anchor['file']][anchor['sheet']][cell]))

    summary = {}
    for branch in ('A', 'B'):
        ids = {job['id'] for job in data['jobs'] if job['purpose'] == 'primary_' + branch.lower()}
        rows = [event['event'] for event in data['events'] if event['job_id'] in ids]
        transmitted = {id for row in rows for id in row.get('inputRefs', [])}
        native_lines = []
        for row in rows:
            reply = row.get('reply') or {}
            ref = reply.get('evidence') or {}
            body = (reply.get('body') or {}).get('content')
            if ref.get('evidenceId') not in transmitted or not isinstance(body, str):
                continue
            try:
                physical = json.loads(body)
            except ValueError:
                continue
            source = ref['place']['source']['sha256']
            base = (physical.get('address') or {}).get('locator') or {}
            native_lines.extend((source, {**base, **(line.get('locator') or {})}, line.get('text'))
                                for line in physical.get('lines', []))
        findings = [item for item in data['findings'] if item['run_id'] in ids]
        stored = [(part.get('source', payload['source']).get('sha256'), (part.get('address') or {}).get('locator') or {}, part.get('quote'))
                  for payload in (finding['payload'] for finding in findings) for part in items(payload)]
        facets = [(finding.get('package_fact') or {}) for finding in findings]
        summary[branch] = {
            'byCase': {key: {'addresses': len(anchors),
                             'deliveredText': sum(any(match(anchor, *line) for line in native_lines) for anchor in anchors),
                             'acceptedQuote': sum(any(match(anchor, *line) for line in stored) for anchor in anchors)}
                       for key, anchors in groups.items()},
            'attributed': sum(bool(row.get('attribute')) for row in facets),
            'stage': sum(bool(row.get('design_stage')) for row in facets),
            'currentRevision': sum(row.get('revision_status') == 'current' for row in facets),
            'sourceRoles': dict(Counter(row.get('source_role') for row in facets)),
            'compound': sum(bool(finding['payload'].get('components')) for finding in findings),
            'toolFailures': dict(Counter((row.get('reply') or {}).get('body', {}).get('code')
                                        for row in rows if (row.get('reply') or {}).get('body', {}).get('ok') is False)),
        }
    return {'branches': summary, 'comparisonJobs': len(data['comparisons'])}


if __name__ == '__main__':
    try:
        root_path, snapshot_path, *options = sys.argv[1:]
        assert options in ([], ['--continuation'])
        print(json.dumps(score(Path(root_path), Path(snapshot_path), continuation=bool(options)), sort_keys=True))
    except (AssertionError, IndexError, KeyError, OSError, ValueError) as failure:
        print('Primary replay scoring failed:', type(failure).__name__, file=sys.stderr)
        raise SystemExit(1) from None
