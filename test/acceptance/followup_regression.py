"""Evaluate preservation, stale links and letter stage on a frozen managed follow-up."""

import argparse
import json
import re
from pathlib import Path
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile

from score import digest, docx_text, load, normalized


def questions(view):
    return {item['requirement']['positionId']: item for item in view['questions']}


def identity(question):
    return {
        'id': question['id'], 'version': question['version'],
        'dependencyVersion': question['dependencyVersion'],
        'decisionId': (question['decision'] or {}).get('id'),
        'outcome': question['outcome'],
    }


def evaluate(directory):
    cold = load(directory / 'mixed-cold.json')
    cold_machine = load(directory / 'mixed-cold-machine.json')
    before = load(directory / 'mixed-before-followup-history.json')
    declared = load(directory / 'mixed-followup-declared.json')
    followup = load(directory / 'mixed-followup-machine.json')
    after = load(directory / 'mixed-followup-result.json')
    primary = next(name for name, view in before['before'].items()
                   if view['scope']['id'] == cold['letter']['created']['scopeId'])
    before_questions = questions(before['before'][primary])
    machine_questions = questions(followup['captured']['assessments'][primary])
    after_questions = questions(after['assessments'][primary])
    independent = {}
    for key in ('anchor', 'hinge', 'length', 'offset'):
        states = [identity(collection[key]) for collection in (before_questions, machine_questions, after_questions)]
        independent[key] = {'passed': bool(states[0]['decisionId']) and states[0] == states[1] == states[2],
                            'before': states[0], 'machine': states[1], 'after': states[2]}

    letter = cold['letter']
    formats = letter['exports']
    stage = before['before'][primary]['scope']['stage']
    txt = normalized((directory / formats['txt']['file']).read_text(encoding='utf-8'))
    docx = normalized(docx_text(directory / formats['docx']['file']))
    stage_pattern = rf'(?<!\w){re.escape(stage)}(?!\w)'
    old_history, new_history = before['beforeHistory'], after['history']
    during = declared['history']
    old_gap, new_gap = before_questions['gap'], after_questions['gap']
    stale = after['stale']
    new_letter = after['after']
    allowed_formats = set(before_questions['length']['requirement']['requiredFormats'])
    misbound = {}
    for name, frame in (('cold', cold_machine), ('followup', followup)):
        findings = [row['finding'] for row in frame['evidence']['observations']
                    if row['question_id'] == before_questions['length']['id']
                    and row['finding']['kind'] == 'value' and row['finding']['format'] not in allowed_formats]
        misbound[name] = {'candidates': len(findings), 'active': sum(finding['applicability'] == 'active'
                                                                      for finding in findings)}

    checks = {
        'frozenMachineBeforeEngineer': cold['frozenMachineSha256'] == digest(directory / 'mixed-cold-machine.json')
        and after['frozenMachineSha256'] == digest(directory / 'mixed-followup-machine.json'),
        'independentQuestionsPreserved': all(row['passed'] for row in independent.values()),
        'independentScopePreserved': all(questions(view) == questions(after['assessments'][name])
                                         for name, view in before['before'].items() if name != primary),
        'misboundMeasurementsNotActive': not any(row['active'] for row in misbound.values()),
        'stageInTxtAndDocx': bool(stage and re.search(stage_pattern, txt) and re.search(stage_pattern, docx)),
        'exportTextAgrees': txt == docx,
        'currentBlockedDuringIntake': during['current']['status'] == 409 and all(
            during['exports'][fmt]['currentStatus'] == 409 for fmt in formats),
        'oldBasisAddressablyInvalidated': new_history['current']['status'] == 412
        and new_history['current']['value']['code'] == 'letter_basis_stale'
        and all(new_history['exports'][fmt]['currentStatus'] == 412 for fmt in formats)
        and new_gap['outcome'] != 'confirmed_conflict'
        and bool(new_gap['decision']) and old_gap['decision']['id'] != new_gap['decision']['id'],
        'staleSecondSessionRejected': stale['separateSession'] and stale['status'] == 412,
        'historyPreserved': old_history['revision'] == new_history['revision']
        and old_history['sent'] == new_history['sent'] and after['historicalConclusion']['unchanged']
        and all(
            new_history['exports'][fmt]['historicalStatus'] == 200
            and new_history['exports'][fmt]['historicalSha256'] == formats[fmt]['sha256']
            == digest(directory / formats[fmt]['file'])
            for fmt in formats)
        and len(new_history['proofs']) == len(old_history['proofs']) > 0 and all(
            item['status'] == item['originalStatus'] == 200 and item['originalSha256'] == item['expectedSha256']
            for item in new_history['proofs']),
        'noNewExternalRequest': new_letter['createStatus'] == 422
        and new_letter['created']['code'] == 'no_eligible_items' and new_letter['before'] == new_letter['after']
        and not new_letter['exports'],
    }
    verdict = {'passed': all(checks.values()), 'checks': checks, 'stage': stage, 'independent': independent,
               'misboundMeasurements': misbound,
               'affected': {'before': identity(old_gap), 'after': identity(new_gap),
                            'machineBeforeClassification': machine_questions['gap']['machine']['outcome'],
                            'machineAfterClassification': new_gap['machine']['outcome'],
                            'remainingLimits': new_gap['machine']['limitations']}}
    alternative_path = directory / 'mixed-catalog-alternative.json'
    if alternative_path.exists():
        alternative = load(alternative_path)
        gap = questions(alternative['assessments'][primary])['gap']
        new_versions = {item['versionId'] for item in followup['receipt']['versions'].values()}
        raw = [finding for finding in (alternative['storedReview'] or {}).get('findings', [])
               if finding['citation']['versionId'] in new_versions]
        verdict['catalogAlternative'] = {
            'originalCaseUnchanged': alternative['frozenOriginalResultSha256'] == digest(directory / 'mixed-followup-result.json'),
            'separateCatalogVersion': alternative['newCatalogId'] != alternative['previousCatalogId'],
            'equivalenceVerified': 'txt' in gap['requirement']['equivalentFormats'],
            'activeFollowupCitations': [item['citation'] for item in raw if item['applicability'] == 'active'],
            'outcome': gap['machine']['outcome'], 'limitations': gap['machine']['limitations'],
        }
    return verdict


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('evidence', type=Path)
    args = parser.parse_args()
    try:
        verdict = evaluate(args.evidence)
    except (OSError, ValueError, KeyError, TypeError, StopIteration, BadZipFile, ParseError) as error:
        parser.error(f'Incomplete evidence: {error}')
    print(json.dumps(verdict, ensure_ascii=False, indent=2))
    return 0 if verdict['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
