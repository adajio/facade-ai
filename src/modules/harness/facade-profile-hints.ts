import type { Pool, PoolClient } from 'pg';
import { memoryVersion } from '../project-memory/contracts.js';

// These expressions select addresses to review. The readers still establish what the source says.
const type=String.raw`(^|[|;·]\s*)(facade (kind|type)|тип фасада)\s*[:=№–—]\s*(?!not\y|no\y|none\y|n/a\y|unknown\y|unspecified\y|не\y|нет\y|отсутств|неприменим)\S`;
const heading=String.raw`^\s*(?:(?:project facade (?:identifier|id|reference|ref)|идентификатор фасада проекта|код фасада проекта|ссылка на (?:код|идентификатор) фасада проекта|facade (?:mark|designation|id)|марка фасада|обозначение фасада|фасад)\s*[:№=]\s*\S|(?:facade (?:schedule|register|list)|list of facades|(?:ведомость|реестр|перечень) фасадов)\y|(?:facade|фасад)\s+\S+\s+(?:in|at|в|по)\s)`;
const documentHeader=String.raw`^\s*(?:drawing|schedule|elevation|specification|detail|inventory|черт[её]ж|ведомость|спецификация|опись)\s*[|;·].*(project facade (?:identifier|id|reference|ref)|идентификатор фасада проекта|код фасада проекта|(?:facade|фасад)\s*[:№=])`;
const inactive=String.raw`(?:\y(?:superseded|withdrawn|obsolete|draft|not[ -]+current)\y|\y(?:отмен[её]н|архивн|замен[её]н|черновик|недействующ|неактуальн|не\s+действующ))`;
const compass=String.raw`(?:north(?:east|west)?|south(?:east|west)?|east|west)(?:ern)?|(?:северо-восточн|северо-западн|юго-восточн|юго-западн|северн|южн|восточн|западн)(?:ый|ого|ому|ым|ом)`;
const compassHeading=String.raw`^\s*(?:(?:${compass})\s+(?:facade|фасад[аеу]?)|(?:facade|фасад)\s+(?:${compass}))\y`;
export const profileHintPatterns=[type,heading,documentHeader,inactive,compassHeading];

// project, version, reader and unit are pinned column or parameter expressions from the caller.
export function profileHintLines(project:string,version:string,reader:string,unit:string,firstParameter:number) {
  const [contract,type,heading,documentHeader,inactive,compass]=Array.from({length:6},(_,offset)=>`$${firstParameter+offset}`);
  return `SELECT l.line_id FROM project_memory_versions v
    JOIN project_memory_blocks mb ON mb.version_id=v.version_id AND mb.project_id=v.project_id AND mb.contract=v.contract
      AND mb.unit_id=${unit} AND mb.ordinal<v.next_ordinal AND mb.artifact_sha256 IS NOT NULL AND NOT ('native'=ANY(mb.remaining))
    JOIN project_memory_lines l ON l.block_id=mb.id
    WHERE v.project_id=${project} AND v.version_id=${version} AND v.reader_version=${reader} AND v.contract=${contract}
      AND (l.folded~${type} OR l.folded~${heading} OR l.folded~${documentHeader} OR l.folded~${compass}) AND l.folded!~${inactive}
      AND NOT (l.folded~${type} AND EXISTS (SELECT 1 FROM project_memory_lines preceding
        WHERE preceding.block_id=l.block_id AND preceding.ordinal=l.ordinal-1 AND preceding.folded~${inactive}
          AND (preceding.folded~${heading} OR preceding.folded~${documentHeader} OR preceding.folded~${compass})))
    ORDER BY NOT (l.folded~${type}),l.ordinal LIMIT 8`;
}

export async function currentProfileHintLines(db:Pool|PoolClient,projectId:string,versionId:string,readerVersion:string,unitId:string) {
  const {rows}=await db.query<{line_id:string}>(profileHintLines('$1','$2','$3','$4',5),
    [projectId,versionId,readerVersion,unitId,memoryVersion,...profileHintPatterns]);
  return rows.map(({line_id})=>line_id);
}
