import { includeLayerEvidence } from './layer-composition.mjs';
import { publishSheetObservations } from './sheet-review.mjs';
import { renderQuestions } from './review-analysis.mjs';
import { applyFactApplicability } from './fact-applicability.mjs';
import { validate } from './producer.mjs';

// Validate each catalog row independently only after strict whole-result validation fails.
// No unsupported fragment of a rejected row reaches the publication or its letter.
export function validatedPartial(snapshot,result) {
  const input=availableRows(snapshot,result);
  input.rows=includeLayerEvidence(snapshot,input);
  if (snapshot.factScopeVersion===1) {
    const requirements = new Map(snapshot.requirements.map(requirement=>[requirement.key,requirement]));
    input.rows=input.rows.map(row=>applyFactApplicability(row,{requireFactScope:true,requirement:requirements.get(row.key)}));
    input.draftText=renderQuestions(input.rows);
  }
  return publishSheetObservations(snapshot,input,result);
}

const undecided = key => ({key,status:'unassessed',
  finding:'Позиция требует сверки с источником. Часть сведений недоступна или не прошла проверку.',
  citations:[],analysis:{applicability:{kind:'undetermined',reason:'Требуется сверка с источником.',citations:[]},
    properties:[],tensions:[]}});

function verifiedProperties(snapshot,requirement,row) {
  if (!Array.isArray(row?.analysis?.properties)) return;
  const scoped=snapshot.factScopeVersion===1;
  if (!scoped && (!row.analysis.properties.length || !Array.isArray(row.analysis.tensions))) return;
  const subset={...snapshot,requirements:[requirement]};
  const valid=entry=>{
    try { validate(subset,{rows:[entry]}); return true; }
    catch { return false; }
  };
  let repaired=scoped ? undecided(requirement.key) : {
    ...row,finding:'Адресные сведения приведены по свойствам ниже. Часть сведений требует сверки с источником.',
    status:row.citations?.length ? 'partial' : 'unassessed',
    analysis:{...row.analysis,properties:[],tensions:[]},
  };
  if (!valid(repaired)) return;
  const accept=entry=>{
    if (valid(entry)) repaired=entry;
  };
  if (scoped && row.analysis.applicability)
    accept({...repaired,analysis:{...repaired.analysis,applicability:row.analysis.applicability}});
  const duplicateKeys=new Set();
  const seenKeys=new Set();
  for (const property of row.analysis.properties) {
    if (seenKeys.has(property?.key)) duplicateKeys.add(property?.key);
    seenKeys.add(property?.key);
  }
  for (const property of row.analysis.properties) {
    if (duplicateKeys.has(property?.key)) continue;
    const related=(Array.isArray(row.analysis.tensions) ? row.analysis.tensions : [])
      .filter(tension=>tension?.propertyKey===property?.key);
    const analysis={...repaired.analysis,properties:[...repaired.analysis.properties,property]};
    const candidate={...repaired,analysis:{...analysis,tensions:[...analysis.tensions,...related]}};
    if (valid(candidate)) repaired=candidate;
    else if (related.length && property?.status!=='conflicting') accept({...repaired,analysis});
  }
  return repaired.analysis.properties.length || scoped && repaired.analysis.applicability.kind!=='undetermined'
    ? repaired : undefined;
}

function availableRows(snapshot,result) {
  try { return validate(snapshot,result); }
  catch (original) {
    if (snapshot.reviewContract!==2 || !Array.isArray(result?.rows)) throw original;
    let usable=0;
    const rejected=[];
    const rows=snapshot.requirements.map(requirement=>{
      const matches=result.rows.filter(item=>item?.key===requirement.key);
      if (matches.length===1) {
        try {
          validate({...snapshot,requirements:[requirement]},{rows:matches});
          usable++;
          return matches[0];
        } catch {
          const partial=verifiedProperties(snapshot,requirement,matches[0]);
          if (partial) { usable++; rejected.push(requirement.key); return partial; }
        }
      }
      rejected.push(requirement.key);
      return undecided(requirement.key);
    });
    if (!usable || !rejected.length) throw original;
    const input=validate(snapshot,{rows});
    input.scopeNote+=' По следующим требованиям часть сведений требует повторной сверки: '+rejected.join(', ')+'.';
    return input;
  }
}
