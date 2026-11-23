import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const roleTerms = [
  ['inventory', /\b(?:inventory|transmittal)\b|опись|сопроводительн\p{L}*\s+письмо/iu],
  ['specification', /\bspecification\b|спецификация/iu],
  ['calculation', /\bcalculation\b|расч[её]т/iu],
  ['drawing', /\bdrawing\b|черт[её]ж|схема/iu],
  ['detail', /\bdetail\b|узел|деталь/iu],
  ['schedule', /\bschedule\b|ведомость|таблица/iu],
  ['other', /\b(?:commercial offer|quotation|reference material)\b|коммерческое предложение/iu],
  ['correspondence', /\b(?:correspondence|letter)\b|переписка|письмо/iu],
];

function citations({ content, evidence }) {
  if (!evidence || typeof content !== 'string') return [];
  assert.equal(digest(content), evidence.sha256, 'transport saw a modified textual representation');
  const native = JSON.parse(content);
  return (native.lines ?? []).flatMap((line) => {
    const quote = line.text?.trim();
    if (!quote || quote.length > 500) return [];
    return [{ quote, lineId: line.id ?? line.lineId, evidenceId: evidence.evidenceId }];
  });
}

function addressedProposal(source) {
  const { quote } = source;
  const role = quote.split(/[|;·]/u).map((clause) => clause.trim().replace(
    /^(?:document(?: type| role)?|type|title|тип документа|вид документа|документ)\s*:\s*/iu, ''))
    .flatMap((clause) => roleTerms.flatMap(([value, pattern]) => {
      const marker = pattern.exec(clause);
      return marker?.index === 0 ? [{ value, quote: marker[0] }] : [];
    }))[0];
  const value = /(?<!\d)([+-]?\d+(?:[.,]\d+)?)\s*(мм|см|кг|MPa|mm|cm|kg)(?!\p{L})/iu.exec(quote);
  const stage = /(?:\bStage|стадия)\s*[:=]?\s*([\p{L}\d]+)(?!\p{L})/iu.exec(quote)?.[1];
  const revision = /(?:\brev(?:ision)?\.?|редакция|ревизия)\s*[:=]?\s*([\p{L}\d_.-]+)(?!\p{L})/iu.exec(quote)?.[1];
  const inactive = /superseded|obsolete|withdrawn|архивн|замен[её]н|не\s+действующ/iu.test(quote);
  const current = /\b(?:current|effective)\b|действующ|актуальн/iu.test(quote);
  const common = /all facades?|common materials?|все[хм]?\s+фасад|общ(?:ие|ий|ая|его)\s+(?:материал|раздел|требован)/iu.test(quote);
  const register = /(?:complete|full|exhaustive)\s+(?:list|schedule|register)\s+of\s+facades?|(?:полн\p{L}*|исчерпывающ\p{L}*)\s+(?:перечень|список|ведомость)\s+фасад/iu.test(quote);
  const projectIdentifiers = [...quote.matchAll(/(?:project facade (?:identifier|id)|идентификатор фасада проекта|код фасада проекта)\s*[:=№]\s*([^|;·,]+)/giu)]
    .map(([text, label]) => ({ label: label.trim(), quote: text.trim() }));
  const printedSubjects = [...quote.matchAll(/(?:\bfacades?|фасад(?:ы|ов|а)?)\s*[:=]\s*([^;|·]{1,110})/giu)]
    .flatMap((match) => match[1].split(/\s*(?:,|\band\b|\bи\b)\s*/iu));
  const elevation = /(?:^|[|;·])\s*(?:elevation|фасад)\s+([\p{L}\p{N}_-]{1,35})\s*(?=$|[|;·])/iu.exec(quote)?.[1];
  const labels = [...new Set([...projectIdentifiers.map(({ label }) => label), ...printedSubjects, ...(elevation ? [elevation] : [])]
    .map((label) => label.trim()))]
    .filter((label) => /^[\p{L}\p{N}][\p{L}\p{N}_ -]{0,35}$/u.test(label));
  const building = /(?:building|block|корпус|здани[ея]|секция)\s*[:№=]\s*([^|;·]+)/iu.exec(quote);
  const axes = /(?:axes|grid|оси|осях)\s*[:№=]\s*([^|;·]+)/iu.exec(quote);
  const projectContext = building && axes && {
    building: { value: building[1].trim(), quote: building[0].trim() },
    axes: { value: axes[1].trim(), quote: axes[0].trim() },
  };
  const ambiguous = /unconfirmed|unknown|ambiguous|уточня|неясн|не\s+установлен/iu.test(quote);
  const absence = role?.value === 'inventory' && /(?:not (?:supplied|provided|delivered|included|sent|transmitted)|не\s+(?:передан|предоставлен|направлен|приложен))\p{L}*/iu.test(quote);
  const prefixProperty = /(?:item|attribute|property|позиция|параметр|требование)\s*[:=]\s*([^;|,.]{1,90})/iu.exec(quote)?.[1]?.trim();
  const measurementLabel = value && /(?:^|[|;·])\s*([\p{L}][\p{L}\p{N} _-]{1,70}?)\s*[:=]?\s*$/u.exec(quote.slice(0, value.index))?.[1];
  const absentLabel = absence && /(?:^|[|;·])\s*([\p{L}][\p{L}\p{N} _-]{1,70}?)\s+(?:(?:was|is|has been)\s+)?not\s+(?:supplied|provided|delivered|included|sent|transmitted)/iu.exec(quote)?.[1];
  const property = prefixProperty || measurementLabel || absentLabel;
  if (!role && !value && !stage && !revision && !common && !labels.length && !register) return null;
  const binding = common && !labels.length
    ? { state: 'common', labels, quote, reason: 'Общая применимость напечатана в источнике.' }
    : { state: ambiguous ? 'unclear' : labels.length ? 'identified' : 'unidentified', labels, quote,
      reason: 'Обозначения взяты из этой строки оригинала.',
      ...(projectIdentifiers.length && { projectIdentifiers }), ...(projectContext && { projectContext }) };
  return {
    ...source,
    ...(value && !absence ? { value: value[1], unit: value[2] } : {}),
    ...(absence && property ? { sourceRole: 'inventory', deliveryStatement: { status: 'not_delivered', item: property } } : {}),
    package: {
      ...(property && { attribute: property }),
      ...(role && { role }),
      ...(stage && { stage: { value: stage, quote } }),
      ...(revision && { revision: { value: revision, quote, status: inactive ? 'superseded' : current ? 'current' : 'unknown' } }),
      ...(register && binding.state === 'identified' && { subjectRegister: { labels, quote, ...(common && { commonQuote: quote }) } }),
      binding,
    },
  };
}

function remainingProposals(history, attempted) {
  const key = ({ quote, lineId }) => JSON.stringify([quote, lineId]);
  const seen = new Set(attempted.map(key));
  return history.flatMap(citations).flatMap((source) => {
    const id = key(source);
    if (seen.has(id)) return [];
    seen.add(id);
    return addressedProposal(source) ?? [];
  });
}

function chooseTool(job, history, issued, attempted, remaining) {
  if (job.place.page && !issued.some(({ name }) => name === 'survey')) return ['survey', {}];
  if (!issued.some(({ name }) => name === 'extract')) return ['extract', {}];
  const opened = history.flatMap(citations);
  if (!opened.length && !issued.some(({ name }) => name === 'ocr')) return ['ocr', {}];
  const [next] = remaining;
  if (next) return ['save_observation', next];
  if (history.some(({ observationId, qualified }) => observationId && qualified)) {
    return ['finish_reading', { status: 'covered', explanation: 'Сохранены цитаты из полученного адресного окна.' }];
  }
  if (opened.length && !attempted.length) {
    return ['finish_reading', { status: 'no_match', explanation: 'В полученных строках контрольный извлекатель не нашёл предметной опоры.' }];
  }
  const delivered = history.find(({ evidence }) => evidence);
  if (delivered && !attempted.some(({ limitation }) => limitation)) {
    return ['save_observation', {
      evidenceId: delivered.evidence.evidenceId, limitation: 'Управляемый извлекатель не смог получить пригодную цитату.',
    }];
  }
  if (history.some(({ observationId, qualified }) => observationId && !qualified)) {
    return ['finish_reading', { status: 'unreadable', explanation: 'Сохранено адресное ограничение управляемого извлечения.' }];
  }
  return ['request_next', { reason: 'Контрольный транспорт не получил читаемой адресной выдачи.' }];
}

function reviewPair(job, history, issued) {
  const supports = [['A', job.dispute.a], ['B', job.dispute.b]];
  for (const [support] of supports) {
    if (!issued.some((entry) => entry.name === 'extract' && JSON.parse(entry.arguments).support === support)) {
      return ['extract', { support }];
    }
  }
  const anchors = supports.map(([support, citation]) => {
    const rows = history.filter((entry) => entry.action?.name === 'extract' &&
      JSON.parse(entry.action.arguments).support === support).flatMap(citations);
    return rows.find(({ quote }) => quote.includes(citation.quote));
  });
  const opened = anchors.filter(Boolean);
  const values = (pattern) => anchors.map((anchor) => pattern.exec(anchor?.quote ?? '')?.[1]?.trim().toLowerCase());
  const [variantA, variantB] = values(/(?:variant|execution|вариант|исполнени[ея])\s*[:№=]?\s*([\p{L}\p{N}_.-]+)/iu);
  const [revisionA, revisionB] = values(/(?:revision|rev\.?|редакция|ревизия)\s*[:№=]?\s*([\p{L}\p{N}_.-]+)/iu);
  const scopes = values(/(?:^|[|·;])\s*(?:scope|zone|area|область|участок|зона)\s*[:№=]\s*([^|·;]+)/iu);
  const checks = [
    ['variant', Boolean(variantA && variantA === variantB), 'Сопоставлены напечатанные обозначения исполнения.'],
    ['revision', Boolean(revisionA && revisionB && (revisionA === revisionB ||
      opened.every(({ quote }) => /(?:current|effective)\s+revision|действующая\s+редакция/iu.test(quote)))),
    'Сопоставлены напечатанные действующие редакции.'],
    ['applicability', Boolean(job.scopeName && scopes.every((scope) => scope === job.scopeName.toLowerCase())),
    'На обеих опорах напечатана назначенная область.'],
    ['comparability', Boolean(job.dispute.a.unit && job.dispute.a.unit === job.dispute.b.unit && opened.length === 2 &&
      opened.every(({ quote }, i) => quote.includes(supports[i][1].unit) && quote.includes(supports[i][1].value))),
    'Два значения подтверждены открытыми строками в одной исходной единице.'],
  ];
  const previousRejected = history.some(({ ok, action }) => ok === false &&
    ['propose_resolution', 'verify_resolution'].includes(action?.name));
  const sources = opened.map(({ quote, evidenceId }) => ({ quote, evidenceId }));
  const confirmed = (passed) => opened.length === 2 && passed && !previousRejected;
  const evidence = {
    checks: Object.fromEntries(checks.map(([criterion, passed, reason]) => [criterion, {
      status: confirmed(passed) ? 'confirmed' : 'unclear',
      reason: confirmed(passed) ? reason : 'В заново открытых источниках критерий не подтверждён.',
      sources: confirmed(passed) ? sources : [],
    }])),
    evidenceIds: sources.map(({ evidenceId }) => evidenceId),
    explanation: checks.every(([, passed]) => confirmed(passed))
      ? 'Обе строки заново открыты. Значения расходятся в одном исполнении.'
      : 'Сопоставимость открытых опор остаётся неподтверждённой.',
  };
  return job.mode === 'lead' ? ['propose_resolution', {
    ...evidence, aObservationId: job.dispute.a.observationId, bObservationId: job.dispute.b.observationId,
  }] : ['verify_resolution', {
    ...evidence, verdict: checks.every(([, passed]) => confirmed(passed)) ? 'supported' : 'unclear',
  }];
}

// The fixture responder receives only the current wire assignment and returned tool results.
// It cannot access documents outside the normal reader, application storage, or the scoring oracle.
export function startManagedTransport({ projects, onExchange, onError }) {
  const sessions = new Map();
  const evidenceOwners = new Map();
  return createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      const { attempt, routeId, request } = await new Response(req).json();
      assert.ok(projects.has(attempt.projectId));
      const job = JSON.parse(request.messages[1].content);
      const primary = job.mode === 'primary';
      const branch = primary ? { primary_a: 'a', primary_b: 'b' }[attempt.purpose] :
        /^managed-(lead|a|b)$/u.exec(routeId)?.[1];
      assert.ok(branch && routeId === 'managed-' + branch && request.model === 'managed/' + branch);
      const assigned = primary ? [job.place] : [job.dispute.a.place, job.dispute.b.place];
      assert.ok(assigned.every(({ source }) => source.projectId === attempt.projectId));
      if (primary) {
        assert.equal(job.objective, 'package_primary');
        assert.equal(job.question, undefined);
      } else {
        assert.equal(attempt.purpose, 'review');
        assert.equal(job.dispute.question.id, undefined);
        assert.ok(job.mode === 'lead' ? branch === 'lead' : job.mode === 'verify' && branch !== 'lead');
        assert.notEqual(assigned[0].source.sha256, assigned[1].source.sha256);
      }
      const assignmentHash = digest(JSON.stringify(job));
      const earlier = sessions.get(attempt.jobId);
      if (earlier) assert.deepEqual(earlier, { branch, assignmentHash });
      sessions.set(attempt.jobId, { branch, assignmentHash });
      const calls = request.messages.flatMap(({ role, tool_calls }) => role === 'assistant' ? tool_calls ?? [] : []);
      const issued = calls.map(({ function: fn }) => fn);
      const byCall = new Map(calls.map(({ id, function: fn }) => [id, fn]));
      const history = request.messages.filter(({ role }) => role === 'tool')
        .map(({ content, tool_call_id }) => ({ ...JSON.parse(content), action: byCall.get(tool_call_id) }));
      for (const { evidence } of history) {
        if (!evidence) continue;
        assert.ok(assigned.some(({ source, unitId }) => unitId === evidence.place.unitId &&
          ['projectId', 'versionId', 'documentId', 'sha256'].every((key) => source[key] === evidence.place.source[key])));
        const earlierOwner = evidenceOwners.get(evidence.evidenceId);
        if (earlierOwner) assert.equal(earlierOwner, attempt.jobId, 'evidence leaked across reader jobs');
        evidenceOwners.set(evidence.evidenceId, attempt.jobId);
      }
      const attempted = primary ? issued.filter(({ name }) => name === 'save_observation')
        .map(({ arguments: args }) => JSON.parse(args)) : [];
      const remaining = primary ? remainingProposals(history, attempted) : [];
      const [name, args] = primary ? chooseTool(job, history, issued, attempted, remaining) : reviewPair(job, history, issued);
      assert.ok(request.tools.some(({ function: fn }) => fn.name === name));
      const output = { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
        tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      } }] };
      const receipt = { state: 'paid', costUsdNanos: 0, providerId: 'managed:' + attempt.id, evidenceRef: 'local:' + attempt.id };
      await onExchange({
        branch, routeId, attemptId: attempt.id, jobId: attempt.jobId, projectId: attempt.projectId, assignmentHash,
        ...(primary ? { assignedSource: job.place.source, assignedWindow: job.place.unitId } :
          { pair: job.dispute.id, reviewMode: job.mode, supports: assigned, checkStatus: args.checks &&
            Object.fromEntries(Object.entries(args.checks).map(([key, value]) => [key, value.status])) }),
        action: name,
        ...(primary && { remainingCandidates: remaining.length - (name === 'save_observation' && args.quote ? 1 : 0) }),
        opened: history.filter(({ evidence }) => evidence).map(({ evidence }) => evidence),
        previous: history.at(-1) && { ok: history.at(-1).ok, code: history.at(-1).code, observationId: history.at(-1).observationId },
        ...(args.evidenceId && { submittedEvidenceId: args.evidenceId }),
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ receipt, output }));
    } catch (error) {
      onError(error);
      res.writeHead(500).end();
    }
  });
}
