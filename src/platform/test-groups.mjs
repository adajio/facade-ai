import { spawnSync } from 'node:child_process'
import { globSync } from 'node:fs'

const storageSettings = ['DATABASE_URL', 'FACADE_DATA_DIR', 'FACADE_S3_ENDPOINT', 'FACADE_S3_BUCKET']
const stand = {
  intake: {
    file: 'src/modules/intake/intake.integration.test.mjs',
    required: storageSettings,
  },
  supplements: {
    file: 'test/e2e-supplements/stand.test.mjs',
    required: [...storageSettings, 'FACADE_E2E_BASE_URL', 'FACADE_E2E_OUTPUT'],
  },
}

function runTests(group, files, env) {
  console.log(`[${group}] RUN`)
  const result = spawnSync(process.execPath, ['--test', ...files], { env, stdio: 'inherit' })
  process.exitCode = result.status ?? 1
  console.log(`[${group}] ${result.status === 0 ? 'PASS' : 'FAIL'}`)
  if (result.error) console.error(result.error.message)
}

function runLocal() {
  const standFiles = new Set(Object.values(stand).map(({ file }) => file))
  const files = globSync([
    'dist/**/*.{test,spec}.js',
    'dist/**/test-*.js',
    'src/**/*.{test,spec}.{mjs,cjs,js}',
    'test/**/*.{test,spec}.{mjs,cjs,js}',
  ], { exclude: ['**/node_modules/**'] }).filter((file) => !standFiles.has(file)).sort()
  if (!files.length) {
    console.error('[local] FAIL: no test files found')
    process.exitCode = 1
    return
  }

  // Mixed test files still contain stand cases. Leave those cases skipped even in a stand shell.
  const env = { ...process.env }
  for (const key of [
    'DATABASE_URL',
    'FACADE_ACCESS_TEST',
    'FACADE_CONVERTER_SOCKET',
    'FACADE_HARNESS_INTEGRATION',
    'FACADE_QUESTIONS_WORKER_INTEGRATION',
    'FACADE_STEP11_STAND',
    'IMPORTS_TEST_DB',
    'LETTERS_TEST_DB',
  ]) delete env[key]

  runTests('local', files, env)
}

function runStand(group, { file, required }) {
  const missing = required.filter((key) => !process.env[key]?.trim())
  if (missing.length) {
    console.error(`[${group}] NOT CONFIGURED: missing ${missing.join(', ')}`)
    process.exitCode = 2
    return
  }
  runTests(group, [file], process.env)
}

const group = process.argv[2]
if (group === 'local') runLocal()
else if (Object.hasOwn(stand, group)) runStand(group, stand[group])
else {
  console.error('Select a test group: local, intake, supplements')
  process.exitCode = 2
}
