import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const [operation, envPath, folder, selectedKey] = process.argv.slice(2);
const env = Object.fromEntries([...((await readFile(envPath, 'utf8'))
  .matchAll(/^export ([A-Z0-9_]+)='([^']*)'$/gm))].map(([, key, value]) => [key, value]));
const Bucket = env.FACADE_S3_BUCKET;
assert.match(Bucket ?? '', /^test-follow-up-(?:source|restore)-[a-z0-9]+$/);
const client = new S3Client({
  endpoint: env.FACADE_S3_ENDPOINT, region: env.AWS_REGION, forcePathStyle: true, maxAttempts: 1,
  credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifestPath = join(folder, 's3-manifest.json');
const file = (key) => join(folder, 's3-' + sha(key));

async function read(key) {
  const result = await client.send(new GetObjectCommand({ Bucket, Key: key }));
  assert.ok(result.ContentLength <= 8 * 1024 ** 2, 'Only small synthetic originals belong in this snapshot');
  return { bytes: Buffer.from(await result.Body.transformToByteArray()),
    metadata: result.Metadata ?? {}, type: result.ContentType };
}

try {
  if (operation === 'capture') {
    const list = await client.send(new ListObjectsV2Command({ Bucket }));
    assert.equal(list.IsTruncated, false);
    const manifest = [];
    for (const { Key } of list.Contents ?? []) {
      const object = await read(Key);
      const digest = sha(object.bytes);
      assert.equal(object.metadata.sha256, digest, Key);
      await writeFile(file(Key), object.bytes, { mode: 0o600 });
      manifest.push({ key: Key, sha256: digest, size: object.bytes.length, metadata: object.metadata, type: object.type });
    }
    assert.ok(manifest.length > 2);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ captured: manifest.length, verified: manifest.length }));
  } else {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const affected = selectedKey ? manifest.filter((entry) => entry.key === selectedKey) : manifest;
    assert.ok(affected.length);
    for (const entry of affected) {
      const body = await readFile(file(entry.key));
      assert.equal(sha(body), entry.sha256);
      assert.equal(body.length, entry.size);
      if (operation === 'corrupt') body[0] ^= 1;
      else assert.equal(operation, 'restore');
      await client.send(new PutObjectCommand({ Bucket, Key: entry.key, Body: body, Metadata: entry.metadata, ContentType: entry.type }));
      const after = await read(entry.key);
      assert.equal(after.bytes.length, entry.size);
      assert.equal(after.metadata.sha256, entry.sha256);
      if (operation === 'corrupt') assert.notEqual(sha(after.bytes), entry.sha256);
      else assert.equal(sha(after.bytes), entry.sha256);
    }
    console.log(JSON.stringify({ operation, objects: affected.length, verified: affected.length }));
  }
} finally {
  client.destroy();
}
