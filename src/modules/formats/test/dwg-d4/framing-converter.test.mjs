import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const image = process.env.FACADE_DWG_FRAMING_IMAGE;
const converter = fileURLToPath(new URL('../../converter.sh', import.meta.url));
const original = 'AC1032 synthetic framing fixture\n';
const recovery = '{"OBJECTS":[{"object":"TEXT","text":"Synthetic native recovery"}]}\n';
const valid = '  0\nSECTION\n  2\nENTITIES\n  0\nTEXT\n  1\n\n  0\nENDSEC\n  0\nEOF\n';
const crlf = valid.replaceAll('\n','\r\n');
const multiline = '\uFEFF'+crlf.replace('TEXT\r\n  1\r\n\r\n','MTEXT\r\n  1\r\nfirst\nsecond\r\n');

test('isolated LibreDWG wrapper validates DXF structure and keeps recovery and resource outcomes distinct', {
  skip: !image, timeout:90_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'facade-dwg-framing-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const out = join(root,'out');
  const files = join(root,'case');
  await mkdir(out);
  await chmod(out,0o777);
  await mkdir(files);
  await copyFile(converter,join(files,'candidate.sh'));
  await writeFile(join(files,'original.dwg'),original);
  await writeFile(join(files,'expected.json'),recovery);
  await writeFile(join(files,'dwg2dxf'),
    '#!/bin/sh\ncat "$TEST_CASE/input" > original.dxf\nexit "$(cat "$TEST_CASE/dxf-exit")"\n',{mode:0o755});
  await writeFile(join(files,'dwgread'),
    '#!/bin/sh\ntest "$1 $2 $3 $5" = "-O JSON -o /original.dwg" || exit 99\n: > /out/fallback.called\ncat /case/expected.json > "$4"\nexit "$(cat "$TEST_CASE/json-exit")"\n',{mode:0o755});
  await writeFile(join(files,'driver.sh'),`#!/bin/sh
set -eu
for case_dir in /case/fixtures/*; do
    export TEST_CASE="$case_dir"
    export FACADE_DWG_OUTPUT_BUDGET="$(cat "$case_dir/output-budget")"
    prefix="/out/${'\$'}{case_dir##*/}"
    result=0
    /bin/sh /case/candidate.sh dwg >"$prefix.log" 2>&1 || result=$?
    printf '%s\\n' "$result" >"$prefix.status"
    if [ -e /out/derivative ]; then mv /out/derivative "$prefix.derivative"; fi
    if [ -e /out/fallback.called ]; then mv /out/fallback.called "$prefix.fallback"; fi
    rm -f /out/original.dxf /out/recovered.json
done
`);
  const fixtures = [
    {name:'valid-crlf',dxf:crlf,expected:crlf},
    {name:'valid-mtext',dxf:multiline,expected:multiline},
    {name:'invalid-group',dxf:valid.replace('  1\n','invalid\n'),expected:recovery,fallback:true},
    {name:'missing-entities',dxf:valid.replace('ENTITIES','HEADER'),expected:recovery,fallback:true},
    {name:'eof-value',dxf:'  0\nSECTION\n  2\nENTITIES\n  0\nTEXT\n  1\nEOF\n',expected:recovery,fallback:true},
    {name:'duplicate-entities',dxf:valid.replace('  0\nEOF\n',valid),expected:recovery,fallback:true},
    {name:'unclosed-section',dxf:valid.replace('  0\nENDSEC\n',''),expected:recovery,fallback:true},
    {name:'invalid-text',dxf:crlf.replace('  1\r\n\r\n','  1\r\nfirst\nsecond\r\n'),expected:recovery,fallback:true},
    {name:'disk-limit',dxf:valid,budget:Buffer.byteLength(valid),status:73},
    {name:'disk-signal',dxf:valid,dxfExit:153,status:73},
    {name:'killed',dxf:valid,dxfExit:137,status:137},
    {name:'recovery-disk-limit',dxf:'truncated\n',jsonExit:153,status:73,fallback:true},
    {name:'recovery-failed',dxf:'truncated\n',jsonExit:1,status:1,fallback:true},
  ];
  await mkdir(join(files,'fixtures'));
  for (const fixture of fixtures) {
    const place = join(files,'fixtures',fixture.name);
    await mkdir(place);
    await writeFile(join(place,'input'),fixture.dxf);
    await writeFile(join(place,'dxf-exit'),String(fixture.dxfExit ?? 0));
    await writeFile(join(place,'json-exit'),String(fixture.jsonExit ?? 0));
    await writeFile(join(place,'output-budget'),String(fixture.budget ?? 4096));
  }
  const result = spawnSync('docker', [
    'run','--rm','--pull=never','--init','--network=none','--read-only','--cap-drop=ALL',
    '--security-opt=no-new-privileges=true','--user=65534:65534','--memory=128m','--pids-limit=32',
    '--env','PATH=/case:/usr/bin:/bin',
    '--mount',`type=bind,src=${files},dst=/case,readonly`,
    '--mount',`type=bind,src=${join(files,'original.dwg')},dst=/original.dwg,readonly`,
    '--mount',`type=bind,src=${out},dst=/out`,
    '--entrypoint','/bin/sh',image,'/case/driver.sh',
  ],{encoding:'utf8',timeout:70_000});
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stderr);
  assert.equal(await readFile(join(files,'original.dwg'),'utf8'),original);
  const optional = error => {
    if (error.code !== 'ENOENT') throw error;
  };
  for (const {name,expected,status=0,fallback=false} of fixtures) {
    const diagnostic = name+' '+await readFile(join(out,name+'.log'),'utf8');
    const derivative = await readFile(join(out,name+'.derivative'),'utf8').catch(optional);
    assert.equal(Number(await readFile(join(out,name+'.status'),'utf8')),status,diagnostic);
    assert.equal(derivative,expected,diagnostic);
    assert.equal(Boolean(await stat(join(out,name+'.fallback')).catch(optional)),fallback,diagnostic);
    if (derivative !== undefined) assert.equal((await stat(join(out,name+'.derivative'))).mode & 0o777,0o444,diagnostic);
  }
});
