import { mkdtemp, open, rm, statfs, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { ConverterPortError, converterImage, convertBytes, convertDwg, dwgProfile } from "../converter-port/index.js";
import { ReaderError } from "../pdf/types.js";
import { FormatHold } from "./model.js";

export type Legacy = "doc" | "xls" | "dwg";
type Office = { id: string; format: Exclude<Legacy, "dwg"> };
type Dwg = { id: string; identity: string; format: "dwg"; timeout: number; reserve: number };
export type Converter = Office | Dwg;

export async function converterFor(format: Legacy): Promise<Converter | undefined> {
  if (format === "dwg") {
    const profile = await dwgProfile();
    if (profile) return { ...profile, format };
  } else {
    const id = await converterImage(format);
    if (id) return { id, format };
  }
}

function conversionError(error: unknown): never {
  const scratch = ["ENOSPC", "EDQUOT"].includes((error as NodeJS.ErrnoException)?.code ?? "");
  if (scratch || (error instanceof ConverterPortError && ["unavailable", "busy", "scratch_unavailable", "oda_unavailable"].includes(error.code))) {
    const code = scratch ? "scratch_unavailable" : (error as ConverterPortError).code;
    throw new ReaderError(`converter_${code}`, "Конвертация ожидает доступного брокера или рабочих ресурсов", 503);
  }
  if (error instanceof ConverterPortError) throw new FormatHold(`converter_${error.code}`);
  throw error;
}

export async function convert({ id, format }: Office, input: Buffer) {
  try {
    return await convertBytes(format, input, { image: id });
  } catch (error) {
    return conversionError(error);
  }
}

// Keep the file open while the reader works. Unlinking before writing releases the spool even if the worker exits.
async function derivativeFile(): Promise<FileHandle> {
  const dir = await mkdtemp(join(tmpdir(), "facade-dwg-"));
  const path = join(dir, "derivative");
  let file: FileHandle | undefined;
  try {
    file = await open(path, "wx+", 0o600);
    await unlink(path);
    return file;
  } catch (error) {
    await file?.close();
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(async error => {
      await file?.close();
      throw error;
    });
  }
}

function derivativeSink(file: FileHandle): Writable {
  async function write(bytes: Buffer) {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
      if (!bytesWritten) throw new ConverterPortError("scratch_unavailable");
      offset += bytesWritten;
    }
  }
  return new Writable({
    write(bytes, _encoding, done) {
      void write(bytes).then(() => done(), done);
    },
  });
}

export async function withDwgDerivative<T>(
  path: string, converter: Dwg, use: (file: FileHandle, sha256: string) => Promise<T>,
): Promise<T> {
  const source = await open(path, "r");
  let derivative: FileHandle | undefined;
  try {
    const { size } = await source.stat();
    const magic = Buffer.alloc(6);
    const { bytesRead } = await source.read(magic, 0, magic.length, 0);
    if (bytesRead !== magic.length || !/^AC10\d{2}$/.test(magic.toString("latin1"))) {
      throw new FormatHold("dwg_signature_invalid");
    }
    derivative = await derivativeFile();
    const { sha256 } = await convertDwg(
      source.createReadStream({ start: 0, end: size - 1 }),
      derivativeSink(derivative),
      {
        size, image: converter.id, identity: converter.identity, timeout: converter.timeout,
        async checkSpace(expected) {
          const free = await statfs(tmpdir(), { bigint: true }).catch(() => {
            throw new ConverterPortError("scratch_unavailable");
          });
          if (free.bavail * free.bsize < BigInt(expected) + BigInt(converter.reserve)) {
            throw new ConverterPortError("scratch_unavailable");
          }
        },
      },
    );
    return await use(derivative, sha256);
  } catch (error) {
    return conversionError(error);
  } finally {
    try {
      await source.close();
    } finally {
      await derivative?.close();
    }
  }
}
