import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const production = fileURLToPath(new URL('../infra/local-terra/production/', import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('FACADE_TERRA_DEPLOY_')));
const deployment = {
  FACADE_TERRA_DEPLOY_HOST: 'fixture.example',
  FACADE_TERRA_DEPLOY_HOSTNAME: 'fixture-node',
  FACADE_TERRA_DEPLOY_APP_DIR: '/srv/fixture/app',
};

test('deployment requires an explicit profile before invoking the SSH wrapper', () => {
  for (const profile of [{}, {...deployment, FACADE_TERRA_DEPLOY_APP_DIR: '/srv/fixture/../escape'}]) {
    const result = spawnSync('bash', [join(production,'stage'), 'a'.repeat(40), '/missing-wrapper'], {
      encoding:'utf8', env:{...env,...profile},
    });
    assert.equal(result.status,2);
    assert.match(result.stderr,/Set FACADE_TERRA_DEPLOY_HOST/);
    assert.equal(result.stdout,'');
  }
});

test('stage uses the explicit host and checks the remote hostname before extracting', t => {
  const root = mkdtempSync(join(tmpdir(),'facade-deploy-profile-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  const run = (cmd,args,extra={}) => spawnSync(cmd,args,{cwd:root,encoding:'utf8',env,...extra});
  const git = (...args) => {
    const result = run('git',args);
    assert.equal(result.status,0,result.stderr);
    return result.stdout.trim();
  };

  mkdirSync(join(root,'infra/local-terra/production'),{recursive:true});
  mkdirSync(join(root,'infra/local-terra/transport'));
  for (const file of ['stage','deploy-profile','compose.yaml','status.mjs']) {
    copyFileSync(join(production,file),join(root,'infra/local-terra/production',file));
  }
  writeFileSync(join(root,'infra/local-terra/producer.mjs'),'// Fixture.\n');
  const transport = ['production','worker','deep-reading','codex-client','openrouter-terra'];
  for (const file of [...transport,'mac-bridge']) writeFileSync(join(root,'infra/local-terra/transport',file+'.mjs'),'// Fixture.\n');
  git('init','-q');
  git('add','infra');
  git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','Fixture');
  const sha = git('rev-parse','HEAD');

  const wrapper = join(root,'ssh-fixture');
  writeFileSync(wrapper,String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" > actual-host
printf '%s\n' "$2" > actual-command
tar -tf - > actual-archive
hostname() { printf 'unexpected-node\n'; }
install() { touch unexpected-install; }
export -f hostname install
bash -c "$2"
`,{mode:0o700});

  const stage = 'infra/local-terra/production/stage';
  const result = run('bash',[stage,sha,wrapper],{env:{...env,...deployment}});
  assert.equal(result.status,1,result.stderr);
  assert.equal(readFileSync(join(root,'actual-host'),'utf8').trim(),deployment.FACADE_TERRA_DEPLOY_HOST);
  assert.match(readFileSync(join(root,'actual-command'),'utf8'),/terra-stage fixture-node \/srv\/fixture\/app [a-f0-9]{40}/);
  const files = readFileSync(join(root,'actual-archive'),'utf8').split('\n');
  for (const file of transport) assert(files.includes('./producer/transport/'+file+'.mjs'));
  assert(!files.some(file => file.includes('mac-bridge') || file.includes('/model/')));
  assert.throws(() => readFileSync(join(root,'unexpected-install')),{code:'ENOENT'});

  const archive = run('bash',[stage,sha],{encoding:null});
  assert.equal(archive.status,0,archive.stderr.toString());
  assert(archive.stdout.length > 0);
});
