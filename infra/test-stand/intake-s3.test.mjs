import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { get } from 'node:https';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createIntakeStorage } from '../../dist/src/modules/intake/blob.js';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function unsignedStatus(url) {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
}

test('private S3 over TLS rejects overwrites and returns the original bytes', { timeout: 90_000 }, async (t) => {
  const { FACADE_S3_ENDPOINT, FACADE_S3_BUCKET, FACADE_DATA_DIR } = process.env;
  assert.ok(FACADE_DATA_DIR && FACADE_S3_BUCKET && FACADE_S3_ENDPOINT,
    'Source the dedicated S3 test environment');
  const endpoint = new URL(FACADE_S3_ENDPOINT);
  assert.equal(endpoint.protocol, 'https:');
  assert.equal(endpoint.pathname, '/');
  assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
  const { objects } = createIntakeStorage(FACADE_DATA_DIR);
  try {
    for (const size of [1024, 9 * 1024 ** 2 + 31]) {
      await t.test(`${size} bytes`, async () => {
        const key = `qualification/${randomUUID()}`;
        const original = Buffer.alloc(size, 0x51);
        const replacement = Buffer.alloc(size, 0x52);
        const identity = { size, sha256: sha256(original) };
        try {
          assert.equal(await objects.head(key), undefined);
          await objects.put(key, identity, Readable.from([original]));
          assert.deepEqual(await objects.head(key), identity);
          assert.ok([401, 403, 404].includes(await unsignedStatus(new URL(`/${FACADE_S3_BUCKET}/${key}`, endpoint))));
          const range = await objects.get(key, { start: size - 19, end: size - 1 });
          const rangeBytes = [];
          for await (const chunk of range) rangeBytes.push(chunk);
          assert.deepEqual(Buffer.concat(rangeBytes), original.subarray(-19));

          const hash = createHash('sha256');
          let read = 0;
          for await (const chunk of await objects.get(key)) {
            read += chunk.length;
            hash.update(chunk);
          }
          assert.equal(read, size);
          assert.equal(hash.digest('hex'), identity.sha256);

          const result = await objects.put(key, { size, sha256: sha256(replacement) }, Readable.from([replacement])).then(
            () => 'accepted', (error) => error.$metadata?.httpStatusCode ?? error.name,
          );
          const current = await objects.head(key);
          assert.ok([409, 412].includes(result),
            `Conditional creation returned ${result}; SHA-256 after repeat: ${current?.sha256}; expected: ${identity.sha256}`);
          assert.deepEqual(current, identity);
        } finally {
          await objects.remove(key);
        }
      });
    }
  } finally {
    objects.close();
  }
});
