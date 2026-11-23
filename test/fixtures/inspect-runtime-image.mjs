import assert from 'node:assert/strict';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = '/app';
const forbidden = /\/(?:test|tests|fixtures|gold|e2e)(?:\/|$)|\.(?:test|spec)\.|\/managed-(?:worker|transport)|\/harness\/transport\.js/u;
const appPaths = globSync(['dist/**/*', 'src/**/*', 'web/**/*'], { cwd: root, exclude: ['**/node_modules/**'] });
assert.ok(appPaths.length > 0);
assert.ok(!existsSync(join(root, 'test')));
assert.deepEqual(appPaths.filter((path) => forbidden.test('/' + path)), []);
for (const role of ['api', 'worker']) assert.ok(existsSync(join(root, `dist/apps/${role}/src/main.js`)));
assert.ok(existsSync(join(root, 'web/dist/index.html')));

const imports = new Set();
const hook = registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith(`file://${root}/`) && !url.includes('/node_modules/')) {
      assert.doesNotMatch(url, forbidden);
      imports.add(url);
    }
    return nextLoad(url, context);
  },
});
try {
  const { findModules, loadModule } = await import(pathToFileURL(join(root, 'dist/src/platform/modules.js')).href);
  await import(pathToFileURL(join(root, 'dist/src/platform/api.js')).href);
  const names = await findModules();
  assert.ok(names.includes('harness') && names.includes('gateway'));
  await Promise.all(names.map(loadModule));
  const harness = readFileSync(join(root, 'dist/src/modules/harness/index.js'), 'utf8');
  assert.doesNotMatch(harness, /FACADE_HARNESS_MANAGED_URL|managedTransport/u);
  const toolSha256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
  console.log(JSON.stringify({ mode: 'image-inspection', toolSha256, applicationPaths: appPaths.length, applicationImports: imports.size }));
} finally {
  hook.deregister();
}
