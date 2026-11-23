"""Score cited locations and literal answer fields after the live response is frozen."""
from hashlib import sha256
import json
from pathlib import Path
import runpy
import sys
import unicodedata


fixture = runpy.run_path(str(Path(__file__).with_name('verify-fixtures.py')))


def load(path):
    assert path.is_file() and not path.is_symlink() and not path.stat().st_mode & 0o077
    return json.loads(path.read_text())


def normalize(value):
    text = unicodedata.normalize('NFKC', str(value)).casefold()
    return ''.join(char for char in text if char.isalnum())


def score(root, initial_path, release_path, answer_path):
    manifest = load(root / 'verifier' / 'manifest.json')
    oracle_path = root / 'verifier' / 'oracle.json'
    assert fixture['digest'](oracle_path) == manifest['oracleSha256']
    control = load(oracle_path)['expected']['lateQuestion']
    primary = load(initial_path)
    release = load(release_path)
    assert sha256(initial_path.read_bytes()).hexdigest() == release['primarySha256']
    assert primary['phase'] == 'primary' and release['question'] == control['prompt']
    answer = load(answer_path)
    assert answer['question'] == release['question']
    by_version = {row['version_id']: row['original_sha256'] for row in primary['maps']}
    originals = {Path(entry['path']).name: entry for entry in manifest['originals']}
    citations = answer.get('citations') or []

    def matches(citation, anchor):
        entry = originals[anchor['file']]
        if by_version.get(citation['versionId']) != entry['sha256']:
            return False
        address = citation['address']['locator']
        if 'sheet' in anchor:
            return address.get('sheet') == anchor['sheet'] and address.get('cell') in anchor['cells']
        if address.get('page') != anchor['page']:
            return False
        line = fixture['native_pdf'](root / entry['path'])[anchor['page'] - 1][anchor['line'] - 1]
        quote = normalize(citation['text'])
        return len(quote) >= 4 and (quote in normalize(line) or normalize(line) in quote)

    def hit_count(anchors):
        return sum(any(matches(citation, anchor) for citation in citations) for anchor in anchors)

    claims = answer.get('claims') or []
    return {
        'state': answer['state'], 'reason': answer.get('reason'), 'claims': len(claims),
        'citations': len(citations), 'literalFields': {field: any(normalize(value) in normalize(claim['text'])
                            for claim in claims) for field, value in control['answer'].items()},
        'exactSupportGroups': hit_count(control['supports']), 'expectedSupportGroups': len(control['supports']),
        'previouslyUnselectedGroups': hit_count(control['requiredInPreviouslyUnselectedBlock']),
        'citedRetiredGroups': hit_count(control['distractors']),
    }


if __name__ == '__main__':
    try:
        print(json.dumps(score(*map(Path, sys.argv[1:])), sort_keys=True))
    except (AssertionError, IndexError, KeyError, OSError, TypeError, ValueError) as failure:
        print('Late answer scoring failed:', type(failure).__name__, file=sys.stderr)
        raise SystemExit(1) from None
