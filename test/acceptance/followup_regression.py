"""Evaluate preservation, stale links and letter stage on a frozen managed follow-up."""

import argparse
import json
import re
from pathlib import Path
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile

from score import digest, docx_text, in_directory, load, normalized


def questions(view):
    return {item['requirement']['positionId']: item for item in view['questions']}


def identity(question):
    return {
        'id': question['id'], 'version': question['version'],
        'dependencyVersion': question['dependencyVersion'],
        'decisionId': (question['decision'] or {}).get('id'),
        'outcome': question['outcome'],
    }


def matches_source(citation, place, path, version):
    unit = place['address']['unit']
    page = re.fullmatch(r'page:(\d+)', unit)
    table = re.fullmatch(r'table:(\d+)/R(\d+)C(\d+)', unit)
    if page:
        expected_locator = {'page': int(page[1])}
    elif table:
        expected_locator = dict(zip(('table', 'row', 'column'), map(int, table.groups())))
    else:
        raise ValueError(f'Unsupported letter source address: {unit}')
    locator = citation['address']['locator']
    measurement = {'value': citation['value'], 'unit': {'мм': 'mm'}.get(citation['unit'], citation['unit'])}
    return (citation['sha256'] == place['originalSha256'] and citation['label'] == path
            and citation['versionId'] == version
            and (citation.get('documentRevision') or {}).get('label') == place['revision']
            and measurement in place['variants']
            and all(locator.get(key) == value for key, value in expected_locator.items()))


def displayed_source(source, place, path, body):
    label, citation = source['label'], source['address']
    locator = citation['address']['locator']
    required = [f'«{path}»', f"ред. {place['revision']}"]
    for key, prefix in {'page': 'стр.', 'table': 'табл.', 'row': 'строка', 'column': 'столбец'}.items():
        if key in locator:
            required.append(f'{prefix} {locator[key]}')
    statement = rf"{re.escape(label)}\s+указано\s+{re.escape(citation['value'])}\s+{re.escape(citation['unit'])}(?!\w)"
    return all(re.search(rf'{re.escape(field)}(?!\w)', label) for field in required) and bool(re.search(statement, body))


def letter_semantics(cold, before, letter, question, texts, oracle):
    if oracle['letter']['requests'] != ['gap']:
        raise ValueError('The mixed letter oracle must specify one clearance request')
    places = {place['id']: place for place in oracle['places']}
    paths = {sha: path for path, sha in oracle['originals'].items()}
    required = [places[key] for key in oracle['letter']['decisions']['gap']['sources']]
    if len(required) != 3 or {place['format'] for place in required} != {'pdf', 'docx', 'doc'}:
        raise ValueError('The mixed letter oracle must specify PDF, DOCX and DOC supports')

    eligible = letter['eligible']['items']
    history = before['beforeHistory']
    items = history['revision']['items']
    item = items[0] if len(items) == 1 else {}
    basis = item.get('basis', {})
    stage = 'РД'
    recipient = 'ООО «Испытательная сторона»'
    scope = required[0]['scope']
    subject = 'Зазор QF-91'
    stage_marker = rf'(?<!\w)(?:стадия\s*[:—–-]?\s*|{re.escape(scope)}\s*[,/]\s*){stage}(?!\w)'
    checks = {
        'oneExternalItem': (letter['createStatus'] == 201 and letter['created']['status'] == 'confirmed'
                            and [entry['questionId'] for entry in eligible] == [question['id']]
                            and item.get('questionId') == question['id']
                            and item.get('decisionId') == question['decision']['id']
                            and item.get('kind') == 'confirmed_conflict'
                            and all(re.findall(r'(?m)^\s*(\d+)[.)]\s', body) == ['1'] for body in texts.values())),
        'recipientScopeSubjectStage': (letter['created']['recipient'] == item.get('recipient') == recipient
                                       and basis.get('scope', {}).get('name') == scope
                                       and basis.get('scope', {}).get('stage') == stage and item.get('subject') == subject
                                       and all(all(value.casefold() in body.casefold() for value in (recipient, scope, subject))
                                               and re.search(stage_marker, body, re.I) for body in texts.values())),
        'confirmClearance': bool(item.get('action') and re.search(r'подтвердить|уточнить', item['action'], re.I)
                                 and subject.casefold() in item['action'].casefold()
                                 and all(item['action'].casefold() in body.casefold() for body in texts.values())),
        'exactSourceSet': sorted(citation['sha256'] for citation in basis.get('citations', []))
        == sorted(place['originalSha256'] for place in required),
    }
    source_checks = {}
    for place in required:
        path = paths[place['originalSha256']]
        version = cold['receipt']['versions'][path]['versionId']
        citations = [citation for citation in basis.get('citations', [])
                     if matches_source(citation, place, path, version)]
        displayed = [source for source in item.get('sources', []) if source['address'] in citations]
        delivered = [proof for proof in history['proofs'] if proof['versionId'] == version and any(
            proof['evidenceId'] == citation['evidenceId'] and proof['address'] == citation['address']
            for citation in citations)]
        source_checks[place['id']] = {
            'basis': len(citations) == 1,
            'proof': any(proof['status'] == proof['originalStatus'] == 200
                         and proof['originalSha256'] == proof['expectedSha256'] == place['originalSha256']
                         for proof in delivered),
            **{format_name: any(displayed_source(source, place, path, body) for source in displayed)
               for format_name, body in texts.items()},
        }
    return {'passed': all(checks.values()) and all(all(fields.values()) for fields in source_checks.values()),
            'checks': checks, 'sources': source_checks}


def addressed_replacement(directory, primary, before):
    held = load(directory / 'mixed-original-replacement-hold.json')
    run_path = directory / 'mixed-addressed-replacement.json'
    checks = {
        'originalCatalogHeld': ('txt' not in held['equivalentFormats'] and held['response']['status'] == 422
                                and held['history']['status'] == 200 and not held['history']['value']['replacements']),
    }
    if not run_path.exists():
        return {'passed': False, 'checks': checks, 'originalResponse': held['response'], 'addressedRunPresent': False}
    run = load(run_path)
    prior, current = run['before'][primary], run['after'][primary]
    gap = questions(prior)['gap']
    updated = questions(current)['gap']
    selection = run['selection']
    retired, incoming = selection['replaced'], selection['replacements']
    history = run['history']
    history_before = before['beforeHistory']
    records = (run['applicability']['value'] or {}).get('replacements', [])
    receipt = records[0] if len(records) == 1 else {}
    selected_versions = {item['versionId'] for item in incoming}
    decision = run['finalDecision']
    final_views = decision['assessments'] if decision else run['after']
    final_gap = questions(final_views[primary])['gap']

    def reference(item):
        return item['observationId'], item['evidenceId'], item['versionId']

    def address_key(item):
        return item['versionId'], json.dumps(item['address'], sort_keys=True)

    retired_places = {address_key(citation) for citation in retired}
    active_places = {address_key(finding['citation']) for finding in (run.get('storedReview') or {}).get('findings', [])
                     if finding['applicability'] == 'active'}
    checks.update({
        'frozenOriginalResult': run['frozenOriginalResultSha256'] == digest(directory / 'mixed-followup-result.json'),
        'explicitFormatAdmission': 'txt' in gap['requirement']['equivalentFormats'],
        'selectedThreeOldVersionsAndBothReaders': (selection['ready'] and len({ref['versionId'] for ref in retired}) == 3
                                                   and {ref['branch'] for ref in incoming} == {'A', 'B'}
                                                   and len(selected_versions) == 1),
        'originalsOpened': len(run['proof']) == len(retired) + len(incoming) > 0 and all(
            item and item['status'] == item['originalStatus'] == 200 and item['originalSha256'] == item['expectedSha256']
            for item in run['proof']),
        'commandApplied': run['response']['status'] == 201 and updated['version'] > gap['version'],
        'replacementAudit': (run['applicability']['status'] == 200 and receipt.get('authorId') == run['expectedEngineerId']
                             and receipt.get('id') == (run['response'].get('value') or {}).get('id')
                             and sorted(map(reference, receipt.get('replaced', []))) == sorted(map(reference, retired))
                             and sorted(map(reference, receipt.get('replacements', []))) == sorted(map(reference, incoming))),
        'onlyNewGroundsCloseQuestion': (updated['machine']['outcome'] == 'covered' and bool(selected_versions)
                                       and {item['versionId'] for item in updated['machine']['citations']} == selected_versions
                                       and retired_places.isdisjoint(active_places)),
        'independentQuestionsUnchanged': all(
            question == questions(run['after'][scope])[key] == questions(final_views[scope])[key]
            for scope, view in run['before'].items() for key, question in questions(view).items()
            if (scope, key) != (primary, 'gap')),
        'historicalLetterAndConclusionUnchanged': (bool(history and history_before)
            and history['revision'] == history_before['revision'] and history['sent'] == history_before['sent']
            and len(history['proofs']) == len(history_before['proofs']) > 0 and all(
                item and item['status'] == item['originalStatus'] == 200
                and item['originalSha256'] == item['expectedSha256'] for item in history['proofs'])
            and all(history['exports'][kind]['historicalStatus'] == 200
                    and history['exports'][kind]['historicalSha256'] == entry['historicalSha256']
                    for kind, entry in history_before['exports'].items())
            and run['oldConclusion']['status'] == 200 and run['oldConclusion']['value'] == before['before'][primary]['conclusion']),
        'noExternalItemAfterReplacement': (run['eligible']['status'] == 200
                                           and not (run['eligible']['value'] or {}).get('items')),
        'newEngineerDecision': bool(decision and decision['status'] == 201 and final_gap['outcome'] == 'covered'
                                    and final_gap['decision'] and final_gap['decision']['id'] != (gap['decision'] or {}).get('id')),
    })
    return {'passed': all(checks.values()), 'checks': checks, 'originalResponse': held['response'],
            'addressedResponse': run['response'], 'outcome': updated['machine']['outcome'],
            'limitations': updated['machine']['limitations']}


def evaluate(directory, oracle=None, addressed=False):
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
    txt = normalized(in_directory(directory, formats['txt']['file']).read_text(encoding='utf-8'))
    docx = normalized(docx_text(in_directory(directory, formats['docx']['file'])))
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
    if oracle is not None:
        semantic = letter_semantics(cold, before, letter, old_gap, {'txt': txt, 'docx': docx}, oracle)
        verdict['letterSemantics'] = semantic
        verdict['passed'] = verdict['passed'] and semantic['passed']
    if addressed:
        replacement = addressed_replacement(directory, primary, before)
        verdict['addressedReplacement'] = replacement
        verdict['passed'] = verdict['passed'] and replacement['passed']
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
    parser.add_argument('--letter-oracle', type=Path, help='closed mixed-package oracle for the three-source letter')
    parser.add_argument('--addressed', action='store_true', help='also verify the held and admitted address-replacement commands')
    args = parser.parse_args()
    try:
        verdict = evaluate(args.evidence, load(args.letter_oracle) if args.letter_oracle else None, args.addressed)
    except (OSError, ValueError, KeyError, TypeError, StopIteration, BadZipFile, ParseError) as error:
        parser.error(f'Incomplete evidence: {error}')
    print(json.dumps(verdict, ensure_ascii=False, indent=2))
    return 0 if verdict['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
