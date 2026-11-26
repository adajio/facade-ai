import { includeLayerEvidence } from './layer-composition.mjs';
import { validate } from './producer.mjs';

// Validate each catalog row independently only after strict whole-result validation fails.
// No unsupported fragment of a rejected row reaches the publication or its letter.
export function validatedPartial(snapshot,result) {
  const input=availableRows(snapshot,result);
  input.rows=includeLayerEvidence(snapshot,input);
  return input;
}

function verifiedProperties(snapshot,requirement,row) {
  if (!row?.analysis?.properties?.length || !Array.isArray(row.analysis.tensions)) return;
  const subset={...snapshot,requirements:[requirement]};
  const check=entry=>validate(subset,{rows:[entry]});
  const analysis={...row.analysis,properties:[],tensions:[]};
  const repaired={...row,finding:'Адресные сведения приведены по свойствам ниже. Часть сведений требует сверки с источником.',
    status:row.citations?.length?'partial':'unassessed',analysis};
  try { check(repaired); } catch { return; }
  for (const property of row.analysis.properties) {
    const related=row.analysis.tensions.filter(tension=>tension.propertyKey===property.key);
    const next={...analysis,properties:[...analysis.properties,property],tensions:[...analysis.tensions,...related]};
    try { check({...repaired,analysis:next}); } catch { continue; }
    analysis.properties=next.properties;
    analysis.tensions=next.tensions;
  }
  return analysis.properties.length ? repaired : undefined;
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
      return {key:requirement.key,status:'unassessed',finding:'Позиция требует повторной сверки. Сервис не смог подтвердить разбор по исходным строкам.',
        citations:[],analysis:{applicability:{kind:'undetermined',reason:'Требуется сверка с источником.',citations:[]},properties:[],tensions:[]}};
    });
    if (!usable || !rejected.length) throw original;
    const input=validate(snapshot,{rows});
    input.scopeNote+=' По следующим требованиям часть сведений требует повторной сверки: '+rejected.join(', ')+'.';
    return input;
  }
}
