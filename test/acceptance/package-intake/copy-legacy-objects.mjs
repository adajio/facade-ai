import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';

const require = createRequire('/app/dist/src/modules/intake/blob.js');
const { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const load = async (name) => parseEnv(await readFile('/' + name + '/runtime.env', 'utf8'));
const [source, target] = await Promise.all([load('legacy'), load('restore')]);
assert.match(new URL(source.DATABASE_URL).pathname, /^\/test_pkgintake_base_[a-f0-9]{12}$/u);
assert.match(new URL(target.DATABASE_URL).pathname, /^\/test_pkgintake_legacy_restore_[a-f0-9]{12}$/u);
assert.notEqual(source.FACADE_S3_BUCKET, target.FACADE_S3_BUCKET);
assert.equal(new URL(source.FACADE_S3_ENDPOINT).hostname, 'objects');
assert.equal(source.FACADE_S3_ENDPOINT, target.FACADE_S3_ENDPOINT);
const client = (env) => new S3Client({
  endpoint: env.FACADE_S3_ENDPOINT, region: env.AWS_REGION, forcePathStyle: true,
  credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
});
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const origin = client(source);
const destination = client(target);
const sourceBucket = source.FACADE_S3_BUCKET;
const destinationBucket = target.FACADE_S3_BUCKET;
const copied = [];
let next;
try {
  do {
    const page = await origin.send(new ListObjectsV2Command({ Bucket: sourceBucket, ContinuationToken: next }));
    for (const { Key, Size } of page.Contents ?? []) {
      assert.ok(Key && Number.isSafeInteger(Size) && Size <= 64 * 1024 * 1024);
      const object = await origin.send(new GetObjectCommand({ Bucket: sourceBucket, Key }));
      const bytes = await object.Body.transformToByteArray();
      assert.equal(bytes.length, Size);
      const sha256 = digest(bytes);
      if (object.Metadata?.sha256) assert.equal(sha256, object.Metadata.sha256);
      await destination.send(new PutObjectCommand({
        Bucket: destinationBucket, Key, Body: bytes, Metadata: object.Metadata, ContentType: object.ContentType, IfNoneMatch: '*',
      }));
      const restored = await destination.send(new GetObjectCommand({ Bucket: destinationBucket, Key }));
      assert.equal(digest(await restored.Body.transformToByteArray()), sha256);
      copied.push({ key: Key, size: Size, sha256 });
    }
    next = page.NextContinuationToken;
  } while (next);
  assert.ok(copied.length);
  console.log(JSON.stringify(copied, null, 2));
} finally {
  origin.destroy();
  destination.destroy();
}
