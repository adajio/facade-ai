export function stepEntity(record: string) {
  const match = /^\s*(#[1-9]\d*)\s*=\s*(IFC[A-Z0-9]+)\s*\(([\s\S]*)\)\s*;\s*$/iu.exec(record);
  if (!match) return;
  const [, id, type, raw] = match;
  const args: string[] = [];
  let start = 0, depth = 0, quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "'") {
      if (quoted && raw[i + 1] === "'") i++;
      else quoted = !quoted;
    } else if (!quoted && c === '(') depth++;
    else if (!quoted && c === ')') depth--;
    else if (!quoted && depth === 0 && c === ',') {
      args.push(raw.slice(start, i).trim());
      start = i + 1;
    }
    if (depth < 0) return;
  }
  if (depth || quoted) return;
  return { id, type: type.toUpperCase(), args: [...args, raw.slice(start).trim()] };
}

export function assignmentReferences(entity?: ReturnType<typeof stepEntity>) {
  if (entity?.type !== 'IFCUNITASSIGNMENT' || entity.args.length !== 1) return;
  const refs = /^\(\s*(#[1-9]\d*(?:\s*,\s*#[1-9]\d*)*)\s*\)$/u.exec(entity.args[0])?.[1].split(/\s*,\s*/u);
  return refs && new Set(refs).size === refs.length ? refs : undefined;
}

export function lengthSiUnit(entity?: ReturnType<typeof stepEntity>) {
  if (entity?.type !== 'IFCSIUNIT' || entity.args.length !== 4 || entity.args[1] !== '.LENGTHUNIT.' || entity.args[3] !== '.METRE.') return;
  if (entity.args[2] === '.MILLI.') return 'mm';
  if (entity.args[2] === '$') return 'm';
}

export function ifcLengthProperty(entity?: ReturnType<typeof stepEntity>) {
  if (entity?.type !== 'IFCPROPERTYSINGLEVALUE' || entity.args.length !== 4) return;
  const match = /^IFC(?:POSITIVE|NONNEGATIVE)?LENGTHMEASURE\s*\(\s*([+-]?\d+(?:\.\d*)?(?:E[+-]?\d+)?)\s*\)$/iu.exec(entity.args[2]);
  if (!match) return;
  const value = Number(match[1]);
  return Number.isFinite(value) ? { value, localUnit: entity.args[3] } : undefined;
}

export function projectLengthAssignment(records: readonly string[]) {
  const entities = new Map<string, NonNullable<ReturnType<typeof stepEntity>>>();
  const known = new Set(['IFCSIUNIT', 'IFCCONVERSIONBASEDUNIT', 'IFCCONVERSIONBASEDUNITWITHOFFSET',
    'IFCCONTEXTDEPENDENTUNIT', 'IFCDERIVEDUNIT', 'IFCMONETARYUNIT']);
  for (const record of records) {
    const kind = /^\s*#[1-9]\d*\s*=\s*(IFC[A-Z0-9]+)\s*\(/iu.exec(record)?.[1]?.toUpperCase();
    if (!kind || (kind !== 'IFCPROJECT' && kind !== 'IFCUNITASSIGNMENT' && !known.has(kind))) continue;
    const entity = stepEntity(record);
    if (!entity || entities.has(entity.id)) return;
    entities.set(entity.id, entity);
  }
  const projects = [...entities.values()].filter(({ type }) => type === 'IFCPROJECT');
  if (projects.length !== 1) return;
  const [project] = projects;
  if (project.args.length !== 9) return;
  const assignment = entities.get(project.args[8]);
  const refs = assignmentReferences(assignment);
  if (!assignment || !refs) return;
  const units = refs.map((ref) => entities.get(ref));
  if (units.some((unit) => !unit || !known.has(unit.type))) return;
  const length = units.filter((unit) => unit?.args[1] === '.LENGTHUNIT.');
  if (length.length !== 1 || !length[0] || !lengthSiUnit(length[0])) return;
  return { ifcProjectStep: project.id, ifcUnitAssignmentStep: assignment.id, ifcProjectLengthUnitStep: length[0].id };
}
