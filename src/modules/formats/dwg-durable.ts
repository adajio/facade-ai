import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ReaderError } from '../pdf/types.js';
import type { SourceRef } from '../pdf/types.js';

export type DurableDwg = { storageKey: string; sha256: string; size: number; format: 'dxf'|'dwg-json'; converter: string };
const hex = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f-]{36}$/i;
function location(source: SourceRef, sha: string) {
  if (!process.env.FACADE_DATA_DIR) throw new ReaderError('dwg_storage_unavailable','Не настроено постоянное хранилище DWG',503);
  if (!uuid.test(source.projectId) || !uuid.test(source.documentId) || !uuid.test(source.versionId) || !hex.test(sha)) {
    throw new ReaderError('dwg_derivative_invalid','Недопустимая идентичность производной',424);
  }
  const key = join('dwg-derivatives',source.projectId,source.documentId,source.versionId,sha);
  return { key, path: join(process.env.FACADE_DATA_DIR,key) };
}
const verified = new Map<string,string>();
const signature = (s: Awaited<ReturnType<typeof stat>>) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
export async function verifyDwgFile(source: SourceRef, sha: string, expectedSize?: number, reuse = false) {
  const {path,key} = location(source,sha);
  const h = createHash('sha256'); let size = 0;
  try {
    const before = await stat(path);
    if (reuse && verified.get(path) === signature(before) && before.size === expectedSize) return {path,storageKey:key,size:before.size};
    for await (const chunk of createReadStream(path)) { h.update(chunk as Buffer); size += (chunk as Buffer).length; }
    const after = await stat(path);
    if (signature(before) !== signature(after)) throw new ReaderError('dwg_derivative_invalid','Производная изменилась при проверке',424);
    if (!size || h.digest('hex') !== sha || (expectedSize !== undefined && size !== expectedSize))
      throw new ReaderError('dwg_derivative_invalid','Контрольная сумма производной DWG не совпадает',424);
    if (verified.size >= 2048) verified.clear();
    verified.set(path,signature(after));
  } catch (error) {
    verified.delete(path);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof ReaderError) throw error;
    throw new ReaderError('dwg_derivative_unavailable','Производная DWG недоступна',424);
  }
  return { path, storageKey:key, size };
}
export async function persistDwgFile(source: SourceRef, file: FileHandle, sha: string) {
  const target = location(source,sha);
  const directory = join(target.path,'..');
  let temporary: string | undefined;
  try {
    await mkdir(directory,{recursive:true,mode:0o700});
    temporary = await mkdtemp(join(directory,'.pending-'));
    const tmp = join(temporary,'data');
    await pipeline(file.createReadStream({start:0,autoClose:false}),createWriteStream(tmp,{flags:'wx',mode:0o600}));
    const copied = await open(tmp,'r+'); try { await copied.sync(); } finally { await copied.close(); }
    await chmod(tmp,0o400);
    // A linked immutable file is never overwritten, including under concurrent publishers.
    try { await link(tmp,target.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const result = await verifyDwgFile(source,sha);
    if (!result) throw new ReaderError('dwg_derivative_unavailable','Производная DWG не опубликована',424);
    const dir = await open(directory,'r'); try { await dir.sync(); } finally { await dir.close(); }
    return result;
  } catch (error) {
    if (error instanceof ReaderError) throw error;
    throw new ReaderError('dwg_storage_unavailable','Не удалось сохранить производную DWG',503);
  } finally { if (temporary) await rm(temporary,{recursive:true,force:true}); }
}

export async function openVerifiedDwgFile(path: string, sha: string, expectedSize: number) {
  let file: FileHandle;
  try { file = await open(path,'r'); } catch { throw new ReaderError('dwg_derivative_unavailable','Производная DWG недоступна',424); }
  try {
    const before = await file.stat();
    const hash = createHash('sha256'); let size = 0;
    for await (const chunk of file.createReadStream({start:0,autoClose:false})) { hash.update(chunk as Buffer); size += (chunk as Buffer).length; }
    const after = await file.stat();
    if (size !== expectedSize || hash.digest('hex') !== sha || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new ReaderError('dwg_derivative_invalid','Контрольная сумма производной DWG не совпадает',424);
    return file;
  } catch (error) { await file.close(); throw error; }
}
