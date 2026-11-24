"""Measure the later cut without reopening the frozen primary verdict."""
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
import sys


def load(path):
    assert path.is_file() and not path.is_symlink() and not path.stat().st_mode & 0o077
    return json.loads(path.read_text())


def score(root, primary_path, before_path, after_path):
    primary, before, after = [load(path) for path in (primary_path, before_path, after_path)]
    assert primary['phase'] == 'primary' and primary['helper'] == []
    assert before['phase'] == after['phase'] == 'continuation'
    assert primary['project']['id'] == before['project']['id'] == after['project']['id']
    assert before['helper'] and before['helper'] == after['helper']
    manifest = load(root / 'verifier' / 'manifest.json')
    additions = {entry['sha256'] for entry in manifest['originals'] if entry['path'].startswith('supplement/')}
    assert len(additions) == 2
    version_hashes = {row['version_id']: row['original_sha256'] for row in after['maps']}
    initial_findings = {item['id'] for item in primary['findings']}
    prior_findings = {item['id'] for item in before['findings']}
    assert initial_findings <= prior_findings <= {item['id'] for item in after['findings']}
    paid = [attempt for attempt in after['localAttempts'] if attempt['state'] == 'paid']
    before_paid = {attempt['id'] for attempt in before['localAttempts'] if attempt['state'] == 'paid'}
    assert before_paid <= {attempt['id'] for attempt in paid}
    assert len({attempt['effect_key'] for attempt in paid}) == len(paid)
    pin_receipts = [attempt['receipt'] for attempt in paid]
    assert all(receipt['routeVerified'] for receipt in pin_receipts)
    assert len({receipt['providerId'] for receipt in pin_receipts}) == len(paid)

    branches = {}
    for branch in ('A', 'B'):
        jobs = [job for job in after['jobs'] if job['purpose'] == 'primary_' + branch.lower()]
        job_ids = {job['id'] for job in jobs}
        supplement_jobs = {job['id'] for job in jobs
                           if job['payload']['place']['source']['sha256'] in additions}
        events = [row['event'] for row in after['events'] if row['job_id'] in job_ids]
        delivered = {ref for event in events for ref in event.get('inputRefs', [])}
        opened = [item for item in after['evidence'] if item['run_id'] in job_ids]
        new_sources = {version_hashes[item['version_id']] for item in opened
                       if item['id'] in delivered and version_hashes.get(item['version_id']) in additions}
        new_attempts = [attempt for attempt in paid if attempt['id'] not in before_paid and attempt['job_id'] in job_ids]
        new_findings = [item for item in after['findings'] if item['run_id'] in job_ids and item['id'] not in prior_findings]
        supplement_findings = [item for item in new_findings if version_hashes.get(item['version_id']) in additions]
        branches[branch] = {
            'states': dict(Counter((job['reason'] or job['state']) for job in jobs)),
            'newObservations': len(new_findings),
            'supplementJobs': len(supplement_jobs),
            'supplementOriginsDelivered': len(new_sources),
            'supplementOriginsWithObservations': len({item['version_id'] for item in supplement_findings}),
            'supplementObservations': len(supplement_findings),
            'supplementCalls': sum(attempt['job_id'] in supplement_jobs for attempt in new_attempts),
            'newPaidCalls': len(new_attempts),
            'newPaidUsdNanos': sum(attempt['receipt']['costUsdNanos'] for attempt in new_attempts),
        }
    return {
        'primarySha256': sha256(primary_path.read_bytes()).hexdigest(),
        'retainedPrimaryObservations': len(initial_findings),
        'duplicatePaidEffects': 0,
        'indexedSupplementOrigins': len({version_hashes.get(block['version_id']) for block in after['memory']} & additions),
        'comparisonJobs': len(after['comparisons']),
        'branches': branches,
    }


if __name__ == '__main__':
    try:
        print(json.dumps(score(*map(Path, sys.argv[1:])), sort_keys=True))
    except (AssertionError, IndexError, KeyError, OSError, TypeError, ValueError) as failure:
        print('Continuation scoring failed:', type(failure).__name__, file=sys.stderr)
        raise SystemExit(1) from None
