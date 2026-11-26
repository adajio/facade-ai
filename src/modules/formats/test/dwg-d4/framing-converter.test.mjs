import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const image = process.env.FACADE_DWG_FRAMING_IMAGE;
const entrypoint = '/usr/local/bin/facade-oda-convert';
const original = 'AC1032 synthetic framing fixture\n';
const dxf = '  0\nSECTION\n  2\nHEADER\n  9\n$ACADVER\n  1\nAC1027\n  0\nENDSEC\n  0\nSECTION\n  2\nENTITIES\n  0\nENDSEC\n  0\nEOF\n';
const crlf = dxf.replaceAll('\n', '\r\n');
const cases = [
  {name: 'valid CRLF', derivative: crlf, expected: 0},
  {name: 'missing EOF', derivative: dxf.replace('  0\nEOF\n', ''), expected: 74},
  {name: 'wrong DXF version', derivative: dxf.replace('AC1027', 'AC1032'), expected: 74},
  {name: 'error sidecar', derivative: dxf, sidecar: true, expected: 74},
  {name: 'rejected DWG', derivative: '', converterExit: 1, expected: 74},
  {name: 'disk limit', derivative: dxf, budget: dxf.length, expected: 73},
  {name: 'disk signal', derivative: '', converterExit: 153, expected: 73},
];

test('ODA launcher admits only complete DXF and preserves rejection and disk outcomes', {
  skip: !image, timeout: 120_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'facade-oda-framing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oda = join(root, 'oda');
  const runtime = join(root, 'runtime');
  const xbin = join(runtime, 'usr', 'bin');
  const input = join(root, 'original.dwg');
  await mkdir(oda);
  await mkdir(xbin, { recursive: true });
  await writeFile(input, original, { mode: 0o444 });
  await writeFile(join(xbin, 'Xvfb'), '#!/bin/sh\nprintf "7\\n" >&3\nexec sleep 20\n', { mode: 0o755 });
  await writeFile(join(oda, 'ODAFileConverter'), `#!/bin/sh
set -eu
[ "$*" = '/input /out ACAD2013 DXF 0 0 original.dwg' ]
cat /fixture/converted > /out/original.dxf
if [ -f /fixture/rejected ]; then touch /out/original.err; fi
exit "$(cat /fixture/status)"
`, { mode: 0o755 });

  for (const {name, derivative, budget = 4096, sidecar, converterExit = 0, expected} of cases) {
    await t.test(name, async () => {
      const caseRoot = await mkdtemp(join(root, 'case-'));
      const fixture = join(caseRoot, 'fixture');
      const out = join(caseRoot, 'out');
      await mkdir(fixture);
      await mkdir(out);
      await chmod(out, 0o733);
      await writeFile(join(fixture, 'converted'), derivative);
      await writeFile(join(fixture, 'status'), String(converterExit));
      if (sidecar) await writeFile(join(fixture, 'rejected'), '');
      const result = await exec('docker', [
        'run', '--rm', '--pull=never', '--platform=linux/amd64', '--init', '--network=none', '--read-only',
        '--cap-drop=ALL', '--security-opt=no-new-privileges=true', '--user=65534:65534', '--memory=128m',
        '--pids-limit=32', '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=96m,mode=1777',
        '--env', `FACADE_DWG_OUTPUT_BUDGET=${budget}`,
        '--mount', `type=bind,src=${oda},dst=/oda,readonly`,
        '--mount', `type=bind,src=${runtime},dst=/deps,readonly`,
        '--mount', `type=bind,src=${input},dst=/input/original.dwg,readonly`,
        '--mount', `type=bind,src=${fixture},dst=/fixture,readonly`,
        '--mount', `type=bind,src=${out},dst=/out`,
        '--entrypoint', entrypoint, image, 'dwg',
      ], { timeout: 20_000 }).then(() => ({code: 0}), error => error);
      assert.equal(result.code, expected, result.stderr);
      const files = await readdir(out);
      if (expected === 0) {
        const released = join(out, 'derivative');
        assert.deepEqual(files, ['derivative']);
        assert.equal(await readFile(released, 'utf8'), derivative);
        assert.equal((await stat(released)).mode & 0o777, 0o444);
      } else {
        assert.ok(!files.includes('derivative'));
      }
    });
  }
  assert.equal(await readFile(input, 'utf8'), original);
});
