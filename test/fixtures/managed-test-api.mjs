import { createApi } from '/app/dist/src/platform/api.js';
import { readConfig } from '/app/dist/src/platform/config.js';
import { sealManagedTestDatabase } from '/app/dist/src/platform/runtime-boundary.js';
import { toolHash } from './managed-worker-support.mjs';

if (process.env.FACADE_GATEWAY_LIVE_MODE || process.env.FACADE_GATEWAY_OPENROUTER_KEY) {
  throw new Error('Managed test API requires disabled live gateway');
}

const config = readConfig();
const app = await createApi(config);
try {
  const connection = await sealManagedTestDatabase(app.db);
  connection.release(true);
  await app.listen({ host: config.host, port: config.port });
  app.log.info({ mode: 'managed-test-api', qualifiesProduction: false, toolSha256: toolHash(import.meta.url) }, 'Runtime identity');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void app.close());
} catch (error) {
  await app.close();
  throw error;
}
