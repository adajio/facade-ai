// Receipts and model attempts share only counters and correlation IDs with the internal journal.
export async function recordPrimaryActivity(db, event) {
  const {projectId, receiptId, preparationId = null, stage, status, reason = null, fields = {}, attemptKey} = event;
  if (!['primary_review','revision'].includes(stage) ||
      !['waiting','sending','completed','unknown','rejected','published','partial'].includes(status) ||
      !attemptKey || !projectId || !receiptId) throw Error('invalid_activity');
  const safe = {};
  for (const [key,value] of Object.entries(fields)) {
    if (/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(key) && (typeof value === 'boolean' || Number.isSafeInteger(value) && value >= 0)) safe[key]=value;
    if (key==='reviewId' && typeof value==='string' && /^[0-9a-f-]{36}$/i.test(value)) safe[key]=value;
  }
  const code = reason && /^[a-z0-9_.:-]{1,120}$/i.test(reason) ? reason : null;
  await db.query(`INSERT INTO project_reading_activity(project_id,receipt_id,preparation_id,stage,status,reason,fields,attempt_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[projectId,receiptId,preparationId,stage,status,code,safe,attemptKey]);
}
