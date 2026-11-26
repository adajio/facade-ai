import type { ReaderUnit } from "../pdf/types.js";
import { originalOnly } from "./model.js";

export const thumbsDbFormat = "thumbsdb";
export const windowsThumbnailCache = "windows_thumbnail_cache";

export function thumbnailCacheUnits(format: string | null, units: readonly unknown[] | null): boolean {
  if (format !== thumbsDbFormat || units?.length !== 1) return false;
  const unit = units[0] as ReaderUnit | undefined;
  return unit?.id === "original" && unit.locator?.coverage === "original_only" &&
    unit.locator?.limitations === windowsThumbnailCache;
}
export function isThumbsDbName(name: string) {
  return /^thumbs\.db$/i.test(name.split(/[\\/]/).at(-1) ?? "");
}

const magic = Buffer.from("d0cf11e0a1b11ae1", "hex");
const free = 0xffffffff, end = 0xfffffffe, fatSector = 0xfffffffd, difatSector = 0xfffffffc;
const imageSignatures = ["ffd8ff", "89504e470d0a1a0a", "474946383761", "474946383961"].map(hex => Buffer.from(hex, "hex"));

/** Inspect allocated directory entries and the start of their streams, without extracting thumbnails. */
export function isWindowsThumbnailCache(bytes: Buffer): boolean {
  if (bytes.length < 512 || !bytes.subarray(0, 8).equals(magic) || bytes.readUInt16LE(28) !== 0xfffe
      || bytes.readUInt16LE(32) !== 6 || bytes.readUInt32LE(56) !== 4096) return false;
  const major = bytes.readUInt16LE(26), shift = bytes.readUInt16LE(30);
  if (!(major === 3 && shift === 9 || major === 4 && shift === 12)) return false;
  const sectorSize = 1 << shift, entriesPerSector = sectorSize / 4, sectorCount = bytes.length / sectorSize - 1;
  if (!Number.isInteger(sectorCount) || sectorCount < 2) return false;
  const validSector = (id: number) => id < sectorCount;
  const sector = (id: number) => bytes.subarray((id + 1) * sectorSize, (id + 2) * sectorSize);
  const fatCount = bytes.readUInt32LE(44), difatCount = bytes.readUInt32LE(72);
  if (!fatCount || fatCount > sectorCount || difatCount > sectorCount) return false;
  const sectorsUsed = new Set<number>();
  const difat: number[] = [];
  function addFat(id: number) {
    if (id === free) return true;
    if (!validSector(id) || sectorsUsed.has(id) || difat.length >= fatCount) return false;
    sectorsUsed.add(id);
    difat.push(id);
    return true;
  }
  for (let offset = 76; offset < 512; offset += 4) if (!addFat(bytes.readUInt32LE(offset))) return false;
  let difatId = bytes.readUInt32LE(68);
  const difatIds: number[] = [];
  for (let part = 0; part < difatCount; part++) {
    if (!validSector(difatId) || sectorsUsed.has(difatId)) return false;
    sectorsUsed.add(difatId);
    difatIds.push(difatId);
    const table = sector(difatId);
    for (let offset = 0; offset < sectorSize - 4; offset += 4) if (!addFat(table.readUInt32LE(offset))) return false;
    difatId = table.readUInt32LE(sectorSize - 4);
  }
  if (difat.length !== fatCount || difatId !== end && difatId !== free) return false;
  function fat(id: number) {
    const table = difat[Math.floor(id / entriesPerSector)];
    return table === undefined ? free : sector(table).readUInt32LE((id % entriesPerSector) * 4);
  }
  if (difat.some(id => fat(id) !== fatSector) || difatIds.some(id => fat(id) !== difatSector)) return false;
  function chain(id: number, count?: number) {
    const ids: number[] = [];
    while (id !== end) {
      if (!validSector(id) || sectorsUsed.has(id) || count !== undefined && ids.length >= count) return;
      sectorsUsed.add(id);
      ids.push(id);
      id = fat(id);
    }
    if (count === undefined || count === ids.length) return ids;
  }
  const directory = chain(bytes.readUInt32LE(48));
  if (!directory?.length || major === 4 && bytes.readUInt32LE(40) !== directory.length) return false;
  const entries = directory.flatMap(id => {
    const contents = sector(id);
    const slots: Buffer[] = [];
    for (let offset = 0; offset < sectorSize; offset += 128) slots.push(contents.subarray(offset, offset + 128));
    return slots;
  });
  const root = entries[0];
  if (root[66] !== 5) return false;
  const ids = [root.readUInt32LE(76)], seen = new Set<number>();
  const streams: { name: string; start: number; size: number }[] = [];
  for (const id of ids) {
    if (id === free) continue;
    const entry = entries[id];
    if (!entry || seen.has(id) || entry[66] !== 2 || entry.readUInt32LE(76) !== free) return false;
    const size = Number(entry.readBigUInt64LE(120)), length = entry.readUInt16LE(64);
    if (length < 4 || length > 64 || length % 2 || entry.readUInt16LE(length - 2) || size < 4 || size > bytes.length) return false;
    seen.add(id);
    ids.push(entry.readUInt32LE(68), entry.readUInt32LE(72));
    streams.push({ name: entry.toString("utf16le", 0, length - 2), start: entry.readUInt32LE(116), size });
  }
  if (!streams.length || entries.some((entry, id) => id > 0 && entry[66] !== 0 && !seen.has(id)) ||
      new Set(streams.map(({ name }) => name)).size !== streams.length) return false;

  const miniUsed = new Set<number>();
  const miniSize = Number(root.readBigUInt64LE(120));
  let miniFat: number[] | undefined, miniStream: number[] | undefined;
  function prefix({ start, size }: typeof streams[number]) {
    if (size >= 4096) {
      const data = chain(start, Math.ceil(size / sectorSize));
      return data && sector(data[0]).subarray(0, Math.min(64, size));
    }
    if (miniSize > bytes.length) return;
    miniFat ??= chain(bytes.readUInt32LE(60), bytes.readUInt32LE(64));
    miniStream ??= chain(root.readUInt32LE(116), Math.ceil(miniSize / sectorSize));
    if (!miniFat || !miniStream) return;
    let id = start;
    for (let count = 0; count < Math.ceil(size / 64); count++) {
      const table = miniFat[Math.floor(id / entriesPerSector)];
      if (id * 64 >= miniSize || table === undefined || miniUsed.has(id)) return;
      miniUsed.add(id);
      id = sector(table).readUInt32LE((id % entriesPerSector) * 4);
    }
    if (id !== end) return;
    const offset = (start * 64) % sectorSize;
    return sector(miniStream[Math.floor(start * 64 / sectorSize)]).subarray(offset, offset + Math.min(64, size));
  }
  const catalog = streams.find(({ name }) => name === "Catalog");
  if (catalog) {
    const data = prefix(catalog);
    // PRONOM fmt/682, XP Catalog header and count of numbered thumbnail streams.
    if (!data || catalog.size < 16 || data.readUInt32LE() !== 0x00070010 || data[6] !== 0 ||
        data.readUInt16LE(4) !== streams.length - 1 || streams.length < 2) return false;
  }
  const headerSize = catalog ? 12 : 24;
  return streams.filter(stream => stream !== catalog).every(stream => {
    if (!(catalog ? /^\d{1,10}$/u : /^\d{1,5}_[0-9a-f]{1,16}$/iu).test(stream.name)) return false;
    const data = prefix(stream);
    return data && stream.size > headerSize && data.readUInt32LE() === headerSize
      && (!catalog ? data.readUInt32LE(8) === stream.size - headerSize : true)
      && imageSignatures.some(signature => data.subarray(headerSize, headerSize + signature.length).equals(signature));
  });
}

export function parseThumbsDb(bytes: Buffer) {
  return originalOnly(isWindowsThumbnailCache(bytes) ? windowsThumbnailCache : "format_original_only", "original_only");
}
