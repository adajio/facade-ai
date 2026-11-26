// Runs inside the candidate image. Reads the saved native objects through the shipped reader.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from '/app/node_modules/pg/lib/index.js';
import { createRuntimePdfService } from '/app/dist/src/modules/pdf/index.js';

const { projectId, receiptId } = JSON.parse(await readFile('/rehearsal/upload.json', 'utf8'));
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const reader = createRuntimePdfService(db, { dataDir: process.env.FACADE_DATA_DIR });
try {
  const expected = new Set(['north.jpg', 'colour-swatch.png', 'scan.pdf', 'schedule.doc', 'mtext.dwg', 'brief.pdf.sig']);
  const { rows } = await db.query(`
    SELECT o.relative_path AS label, b.unit_id AS "unitId", b.artifact_sha256 AS sha256,
      b.artifact_size::int AS size, b.address, b.limitations, b.remaining
    FROM project_memory_blocks b
    JOIN intake_occurrences o USING (project_id, version_id)
    WHERE o.project_id=$1 AND o.receipt_id=$2 AND b.artifact_sha256 IS NOT NULL AND o.relative_path=ANY($3::text[])
    ORDER BY o.relative_path, b.ordinal
  `, [projectId, receiptId, [...expected]]);
  assert.deepEqual(new Set(rows.map(({ label }) => label)), expected);
  const lines = new Map([...expected].map((label) => [label, []]));
  for (const object of rows) {
    const saved = await reader.readMaterializedNative(projectId, object);
    assert.equal(saved.address.unitId, object.unitId);
    assert.deepEqual(saved.address, object.address);
    lines.get(object.label).push(...saved.lines.map(({ text }) => text));
  }
  assert.match(lines.get('north.jpg').join(' '), /FACADE RIB\s+42\s+MM/i);
  assert.deepEqual(lines.get('colour-swatch.png'), []);
  assert.match(lines.get('scan.pdf').join(' '), /mixed construction sheet/i);
  assert.match(lines.get('schedule.doc').join(' '), /2\.40 mm/);
  assert.match(lines.get('mtext.dwg').join(' '), /FACADE RIB(?:\s|\^J)+67\.25 mm/i);
  assert.match(lines.get('brief.pdf.sig').join(' '), /not included/i);
  assert.ok(rows.some(({ label, unitId, limitations, remaining }) => label === 'scan.pdf' && unitId === '2' &&
    limitations.includes('pdf_non_native_unreviewed') && remaining.includes('ocr')));
  assert.ok(rows.some(({ label, limitations, remaining }) => label === 'colour-swatch.png' &&
    limitations.includes('raster_ocr_empty') && remaining.includes('graphics')));
  assert.ok(rows.some(({ label, limitations }) => label === 'schedule.doc' &&
    limitations.includes('doc_converted_address_approximate')));
  assert.ok(rows.some(({ label, limitations }) => label === 'mtext.dwg' &&
    limitations.includes('cad_converted_handle_unverified')));
  console.log(JSON.stringify(rows, null, 2));
} finally {
  reader.close();
  await db.end();
}
