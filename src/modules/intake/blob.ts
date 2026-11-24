import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { IntakeError } from "./errors.js";

export type ByteRange = { start: number; end: number };
type ObjectIdentity = { size: number; sha256: string };
export const MAX_RECEIPT_BYTES = 10 * 1024 ** 3;
export const DEFAULT_PART_SIZE = 8 * 1024 ** 2;
const DEFAULT_GUARD = 40 * 1024 ** 3;
const DEFAULT_TTL = 7 * 86400;

export interface ObjectStore {
  head(key: string): Promise<ObjectIdentity | undefined>;
  put(key: string, identity: ObjectIdentity, body: Readable): Promise<void>;
  get(key: string, range?: ByteRange): Promise<Readable>;
  remove(key: string): Promise<void>;
  close(): void;
}

export interface IntakeStorage {
  objects: ObjectStore;
  stagingDir: string;
  partSize: number;
  ttlSeconds: number;
  diskGuardBytes: number;
}

function envInteger(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Invalid intake configuration: ${name}`);
  }
  return value;
}

export function createIntakeStorage(dataDir: string): IntakeStorage {
  const endpoint = process.env.FACADE_S3_ENDPOINT;
  const bucket = process.env.FACADE_S3_BUCKET;
  if (!endpoint || !bucket) {
    throw new Error("Intake requires FACADE_S3_ENDPOINT and FACADE_S3_BUCKET");
  }

  const client = new S3Client({
    endpoint,
    region: process.env.AWS_REGION ?? "us-east-1",
    forcePathStyle: true,
  });
  return {
    stagingDir: join(dataDir, "intake-parts"),
    partSize: envInteger("FACADE_INTAKE_PART_BYTES", DEFAULT_PART_SIZE, 1024 ** 2, 64 * 1024 ** 2),
    ttlSeconds: envInteger("FACADE_INTAKE_TTL_SECONDS", DEFAULT_TTL, 1, 30 * 86400),
    diskGuardBytes: envInteger("FACADE_INTAKE_DISK_GUARD_BYTES", DEFAULT_GUARD, 0, Number.MAX_SAFE_INTEGER),
    objects: {
      async head(key) {
        try {
          const object = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
          return { size: object.ContentLength ?? -1, sha256: object.Metadata?.sha256 ?? "" };
        } catch (error) {
          if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
            return undefined;
          }
          throw error;
        }
      },
      async put(key, identity, body) {
        const params = {
          Bucket: bucket,
          Key: key,
          Metadata: { sha256: identity.sha256 },
          ContentType: "application/octet-stream",
          IfNoneMatch: "*",
        };
        if (identity.size === 0) {
          await client.send(new PutObjectCommand({ ...params, Body: Buffer.alloc(0) }));
          return;
        }
        await new Upload({
          client,
          params: { ...params, Body: body, ContentLength: identity.size },
          partSize: DEFAULT_PART_SIZE,
          queueSize: 1,
        }).done();
      },
      async get(key, range) {
        const object = await client.send(new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          Range: range ? `bytes=${range.start}-${range.end}` : undefined,
        }));
        if (range && (object.ContentLength !== range.end - range.start + 1 ||
          !object.ContentRange?.startsWith(`bytes ${range.start}-${range.end}/`))) {
        if (object.Body instanceof Readable) object.Body.destroy();
        throw new IntakeError(424, "original_range_mismatch", "Storage returned a different byte range");
      }
      if (!(object.Body instanceof Readable)) {
          throw new Error("S3 returned an unsupported stream");
        }
        return object.Body;
      },
      async remove(key) {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      },
      close() {
        client.destroy();
      },
    },
  };
}

export type PartIdentity = { number: number; sha256: string };

export function partPath(storage: IntakeStorage, uploadId: string, part: PartIdentity): string {
  return join(storage.stagingDir, uploadId, `${part.number}-${part.sha256}`);
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function freeBytes(storage: IntakeStorage): Promise<bigint> {
  await mkdir(storage.stagingDir, { recursive: true, mode: 0o700 });
  const fs = await statfs(storage.stagingDir, { bigint: true });
  return fs.bavail * fs.bsize;
}

export async function verifyPart(
  storage: IntakeStorage,
  uploadId: string,
  number: number,
  input: Readable,
  identity: ObjectIdentity,
  save: boolean,
): Promise<void> {
  const dir = join(storage.stagingDir, uploadId);
  const hash = createHash("sha256");
  let size = 0;
  const verify = async function* (stream: AsyncIterable<Buffer>) {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > identity.size) {
        throw new IntakeError(422, "part_length_mismatch", "Part exceeds its declared length");
      }
      hash.update(chunk);
      yield chunk;
    }
    if (size !== identity.size || hash.digest("hex") !== identity.sha256) {
      throw new IntakeError(422, "part_checksum_mismatch", "Part length or SHA-256 differs");
    }
  };

  if (!save) {
    for await (const chunk of verify(input)) {
      void chunk;
    }
    return;
  }

  const created = await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const name of await readdir(dir)) {
    if (name.startsWith(".part-") || name.startsWith(`${number}-`)) {
      await rm(join(dir, name), { force: true });
    }
  }
  const temporary = join(dir, `.part-${randomUUID()}`);
  try {
    await pipeline(input, verify, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    await syncPath(temporary);
    await rename(temporary, partPath(storage, uploadId, { number, sha256: identity.sha256 }));
    await syncPath(dir);
    if (created) {
      await syncPath(storage.stagingDir);
      await syncPath(dirname(storage.stagingDir));
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export function partsStream(storage: IntakeStorage, uploadId: string, parts: PartIdentity[]): Readable {
  return Readable.from((async function* () {
    for (const part of parts) yield* createReadStream(partPath(storage, uploadId, part));
  })(), { objectMode: false });
}

export async function verifyOriginal(stream: Readable, identity: ObjectIdentity): Promise<void> {
  let size = 0;
  const hash = createHash("sha256");
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > identity.size) break;
    hash.update(chunk);
  }
  if (size !== identity.size || hash.digest("hex") !== identity.sha256) {
    throw new IntakeError(422, "original_checksum_mismatch", "Original length or SHA-256 differs");
  }
}

export async function removeParts(storage: IntakeStorage, uploadId: string): Promise<void> {
  await rm(join(storage.stagingDir, uploadId), { recursive: true, force: true });
}
