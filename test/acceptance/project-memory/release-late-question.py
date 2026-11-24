"""Release the precommitted late question only after a protected primary snapshot."""
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import sys


def read(path):
    assert path.is_file() and not path.is_symlink() and not path.stat().st_mode & 0o077
    return path.read_bytes()


def norm(value):
    return ' '.join(value.split()).casefold() if isinstance(value, str) else ''


def locator(address):
    return (address or {}).get('locator') or {}


def release(root, snapshot_path, output):
    manifest = json.loads(read(root / 'verifier' / 'manifest.json'))
    oracle = read(root / 'verifier' / 'oracle.json')
    assert sha256(oracle).hexdigest() == manifest['oracleSha256']
    late = json.loads(oracle)['expected']['lateQuestion']
    [anchor] = late['requiredInPreviouslyUnselectedBlock']
    [source] = [item for item in manifest['originals'] if Path(item['path']).name == anchor['file']]
    body = read(snapshot_path)
    snapshot = json.loads(body)
    assert snapshot['phase'] == 'primary' and snapshot['helper'] == []
    versions = {row['version_id'] for row in snapshot['maps'] if row['original_sha256'] == source['sha256']}
    assert len(versions) == 1
    [version] = list(versions)
    sheet = anchor['sheet']
    target_literal = norm(late['answer']['color'])

    def exact(address):
        location = locator(address)
        return location.get('sheet') == sheet and location.get('cell') in anchor['cells']

    def carries(line):
        return target_literal in norm(line.get('literal', line.get('text')))

    memory = [block for block in snapshot['memory'] if block['version_id'] == version]
    indexed = [line for block in memory for line in block['lines']
               if carries(line) and exact(line['address'])]
    assert len(indexed) == 1
    target = locator(indexed[0]['address'])['cell']
    row = int(re.fullmatch(r'[A-Z]+(\d+)', target)[1])

    def exact_row(location):
        if location.get('sheet') != sheet:
            return False
        return location.get('cell') == target or (location.get('firstRow') == row and location.get('lastRow') == row)

    target_blocks = {
        block['id'] for structure in snapshot.get('structures', []) if structure['version_id'] == version
        for block in structure['blocks'] if exact_row(locator(block.get('address')) or block.get('locator', {}))
    }
    job_purpose = {job['id']: job['purpose'] for job in snapshot['jobs']}
    verdict = {}
    for branch in ['A', 'B']:
        ids = {id for id, purpose in job_purpose.items() if purpose == 'primary_' + branch.lower()}
        accepted = any(finding['run_id'] in ids and finding['version_id'] == version and
                       target_literal in norm(finding['payload'].get('quote')) and exact(finding['payload']['address'])
                       for finding in snapshot['findings'])
        selected = any(check['job_id'] in ids and check['block_id'] in target_blocks
                       for check in snapshot['coverageChecks'])
        evidence = set()
        transmitted = set()
        proposed = False
        for item in snapshot['events']:
            if item['job_id'] not in ids:
                continue
            event = item['event']
            transmitted.update(event.get('inputRefs', []))
            if event['kind'] == 'model':
                for call in (event.get('message') or {}).get('tool_calls') or []:
                    function = call['function']
                    if function['name'] in ('save_observation', 'save_compound_observation'):
                        try:
                            arguments = json.loads(function['arguments'])
                        except (TypeError, ValueError):
                            continue
                        proposed |= target_literal in norm(arguments.get('quote')) or any(
                            target_literal in norm(component.get('quote')) for component in (arguments.get('components') or [])
                            if isinstance(component, dict))
            reply = event.get('reply', {})
            ref = reply.get('evidence') or {}
            if ref.get('place', {}).get('source', {}).get('versionId') != version:
                continue
            content = reply.get('body', {}).get('content')
            if not isinstance(content, str):
                continue
            try:
                physical = json.loads(content)
            except ValueError:
                continue
            base = locator(physical.get('address'))
            if any(carries(line) and {**base, **(line.get('locator') or {})}.get('cell') == target
                   and {**base, **(line.get('locator') or {})}.get('sheet') == sheet for line in physical.get('lines', [])):
                evidence.add(ref['evidenceId'])
                selected |= exact_row(base)
        verdict[branch] = dict(indexed=True, returned=bool(evidence), transmitted=bool(evidence & transmitted),
                               selected=selected, proposed=proposed, accepted=accepted)
    unselected = not any(row['selected'] or row['proposed'] or row['accepted'] for row in verdict.values())
    assert not output.parent.stat().st_mode & 0o077
    with os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
        json.dump(dict(primarySha256=sha256(body).hexdigest(), previouslyUnselected=unselected,
                       question=late['prompt']), stream, ensure_ascii=False)
    return dict(previouslyUnselected=unselected, branches=verdict)


if __name__ == '__main__':
    try:
        print(json.dumps(release(*map(Path, sys.argv[1:]))))
    except (AssertionError, IndexError, KeyError, OSError, ValueError) as failure:
        print('Late question gate failed:', type(failure).__name__, file=sys.stderr)
        raise SystemExit(1) from None
