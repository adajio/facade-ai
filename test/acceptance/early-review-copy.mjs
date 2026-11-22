import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';
const require = createRequire('/app/dist/src/modules/intake/blob.js');
const { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const load = async (path) => parseEnv(await readFile(path, 'utf8'));
const source = await load('/source/runtime.env');
const target = await load('/review/runtime.env');
assert.notEqual(source.FACADE_S3_BUCKET, target.FACADE_S3_BUCKET);
const createClient = (env) => new S3Client({
  endpoint: env.FACADE_S3_ENDPOINT,
  region: env.AWS_REGION,
  credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
  forcePathStyle: true,
});
const origin = createClient(source);
const destination = createClient(target);
let keyCount = 0;
let byteCount = 0;
let next;
try {
  do {
    const page = await origin.send(new ListObjectsV2Command({
      Bucket: source.FACADE_S3_BUCKET, ContinuationToken: next,
    }));
    for (const { Key, Size } of page.Contents ?? []) {
      assert.ok(Key && Number.isSafeInteger(Size) && Size <= 64 * 1024 * 1024);
      const object = await origin.send(new GetObjectCommand({ Bucket: source.FACADE_S3_BUCKET, Key }));
      const bytes = await object.Body.transformToByteArray();
      assert.equal(bytes.length, Size);
      if (object.Metadata?.sha256) {
        assert.equal(createHash('sha256').update(bytes).digest('hex'), object.Metadata.sha256);
      }
      await destination.send(new PutObjectCommand({
        Bucket: target.FACADE_S3_BUCKET, Key, Body: bytes, Metadata: object.Metadata, ContentType: object.ContentType,
        IfNoneMatch: '*',
      }));
      keyCount++;
      byteCount += bytes.length;
    }
    next = page.NextContinuationToken;
  } while (next);
  assert.ok(keyCount >= 10);
  console.log(JSON.stringify({ keyCount, byteCount, sourceReadOnly: true, distinctDestination: true }));
} finally {
  origin.destroy();
  destination.destroy();
}
