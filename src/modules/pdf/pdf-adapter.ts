import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Box, type ImageTransform, type ReaderAdapter, type ReaderLine, type ReaderUnit,
  type ReaderAddress, type ReaderOutput, contains, intersect, ReaderError, validBox,
} from './types.js';

const exec = promisify(execFile);
const maxPages = 10_000;
const maxSide = 4096;
const maxPixels = 12_000_000;
const maxDpi = 1200;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function command(program: string, args: string[], stage: string, timeout = 45_000, version = false): Promise<Buffer> {
  try {
    const { stdout, stderr } = await exec(program, args, {
      timeout, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024, encoding: 'buffer',
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        FONTCONFIG_FILE: process.env.FONTCONFIG_FILE, FONTCONFIG_PATH: process.env.FONTCONFIG_PATH,
        TESSDATA_PREFIX: process.env.TESSDATA_PREFIX, LC_ALL: 'C', LANG: 'C', OMP_THREAD_LIMIT: '1',
      },
    });
    return version && stdout.length === 0 ? stderr : stdout;
  } catch (failure) {
    const { code, killed, stderr } = failure as { code?: string; killed?: boolean; stderr?: Buffer };
    if (code === 'ENOENT') {
      throw new ReaderError(`${stage}_unavailable`, `Инструмент ${program} недоступен`, 503);
    }
    if (killed || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new ReaderError(`${stage}_limit`, 'Инструмент достиг предела времени или вывода', 422);
    }
    if (stage === 'pdf_inventory' && /incorrect password/i.test(String(stderr))) {
      throw new ReaderError('pdf_encrypted', 'PDF требует пароль', 422);
    }
    throw new ReaderError(`${stage}_failed`, 'Инструмент не смог прочитать выбранное представление', 422);
  }
}

async function inspect(path: string): Promise<ReaderUnit[]> {
  const summary = (await command('pdfinfo', [path], 'pdf_inventory')).toString('utf8');
  const pages = Number([...summary.matchAll(/^Pages:\s+(\d+)\s*$/gm)].at(-1)?.[1]);
  if (!Number.isSafeInteger(pages) || pages < 1) {
    throw new ReaderError('pdf_inventory_invalid', 'Количество страниц PDF недоступно', 422);
  }
  if (pages > maxPages) throw new ReaderError('pdf_page_limit', 'Превышен предел числа страниц PDF', 422);
  const details = (await command('pdfinfo', ['-f', '1', '-l', String(pages), '-box', path], 'pdf_inventory')).toString('utf8');
  const rotations = new Map<number, number>();
  for (const match of details.matchAll(/^Page\s+(\d+)\s+rot:\s+(-?\d+)\s*$/gm)) {
    rotations.set(Number(match[1]), ((Number(match[2]) % 360) + 360) % 360);
  }
  const cropBoxes = new Map<number, number[]>();
  for (const match of details.matchAll(/^Page\s+(\d+)\s+CropBox:\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*$/gm)) {
    cropBoxes.set(Number(match[1]), match.slice(2).map(Number));
  }
  return Array.from({ length: pages }, (_, index) => {
    const page = index + 1;
    const rotation = rotations.get(page);
    const crop = cropBoxes.get(page);
    const rawWidth = crop ? crop[2] - crop[0] : 0;
    const rawHeight = crop ? crop[3] - crop[1] : 0;
    const locator = { page, ...(rotation === undefined ? {} : { rotation }) };
    if (rotation === undefined || rotation % 90 || !Number.isFinite(rawWidth) || !Number.isFinite(rawHeight)
      || rawWidth <= 0 || rawHeight <= 0) {
      return { id: String(page), locator: { ...locator, limitation: 'pdf_geometry_unavailable' } };
    }
    const sideways = rotation === 90 || rotation === 270;
    return {
      id: String(page), locator,
      width: sideways ? rawHeight : rawWidth,
      height: sideways ? rawWidth : rawHeight,
    };
  });
}

interface Word {
  lineId: string;
  text: string;
  box: Box;
}

function collectLines(words: Word[]): ReaderLine[] {
  const lines = new Map<string, ReaderLine & { box: Box }>();
  for (const word of words) {
    const previous = lines.get(word.lineId);
    if (!previous) {
      lines.set(word.lineId, { id: word.lineId, text: word.text, box: word.box });
      continue;
    }
    const x = Math.min(word.box.x, previous.box.x);
    const y = Math.min(word.box.y, previous.box.y);
    const right = Math.max(word.box.x + word.box.width, previous.box.x + previous.box.width);
    const bottom = Math.max(word.box.y + word.box.height, previous.box.y + previous.box.height);
    previous.text += ` ${word.text}`;
    previous.box = { x, y, width: right - x, height: bottom - y };
  }
  return [...lines.values()];
}

function wordRows(tsv: Buffer, source: 'native' | 'ocr', viewport: Box, transform?: ImageTransform,
  containedWords = false): ReaderLine[] {
  const rows = tsv.toString('utf8').replaceAll('\r\n', '\n').split('\n');
  if (!rows.shift()?.startsWith('level\tpage_num\t')) {
    throw new ReaderError(`pdf_${source}_invalid`, 'Инструмент вернул неизвестный формат координат', 422);
  }
  const words: Word[] = [];
  let segment = 0;
  for (const row of rows) {
    const columns = row.split('\t');
    if (columns[0] !== '5') continue;
    const [left, top, width, height] = columns.slice(6, 10).map(Number);
    const text = columns.slice(11).join('\t').trim();
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || !text) continue;
    const pixelsPerPoint = transform?.pixelsPerPoint ?? 1;
    const word = {
      x: (left + (transform?.pixelOriginX ?? 0)) / pixelsPerPoint,
      y: (top + (transform?.pixelOriginY ?? 0)) / pixelsPerPoint,
      width: width / pixelsPerPoint,
      height: height / pixelsPerPoint,
    };
    const box = containedWords ? (contains(viewport, word) ? word : undefined) : intersect(viewport, word);
    if (!box) {
      segment++;
      continue;
    }
    const lineId = columns.slice(1, 5).join('.');
    words.push({ lineId: containedWords ? `${lineId}:${segment}` : lineId, text, box });
  }
  return collectLines(words);
}

async function render(path: string, page: string, viewport: Box, box: Box, dpi: number): Promise<{
  bytes: Buffer; transform: ImageTransform;
}> {
  const pixelsPerPoint = dpi / 72;
  const pixelOriginX = Math.floor(box.x * pixelsPerPoint);
  const pixelOriginY = Math.floor(box.y * pixelsPerPoint);
  const width = Math.ceil((box.x + box.width) * pixelsPerPoint) - pixelOriginX;
  const height = Math.ceil((box.y + box.height) * pixelsPerPoint) - pixelOriginY;
  if (Math.max(width, height) > maxSide || width * height > maxPixels
    || Math.max(viewport.width, viewport.height) * pixelsPerPoint > 100_000) {
    throw new ReaderError('pdf_render_limit', 'Уменьшите рамку или разрешение PDF', 422);
  }
  const bytes = await command('pdftoppm', [
    '-f', page, '-l', page, '-singlefile', '-cropbox', '-r', String(dpi), '-png',
    '-x', String(pixelOriginX), '-y', String(pixelOriginY), '-W', String(width), '-H', String(height), path,
  ], 'pdf_render');
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(pngSignature)
    || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new ReaderError('pdf_render_invalid', 'Инструмент не вернул изображение PNG', 422);
  }
  const renderedWidth = bytes.readUInt32BE(16);
  const renderedHeight = bytes.readUInt32BE(20);
  // pdfinfo rounds CropBox to hundredths of a point. A fractional final pixel can be clipped.
  if (renderedWidth <= 0 || renderedHeight <= 0
    || Math.abs(renderedWidth - width) > 1 || Math.abs(renderedHeight - height) > 1) {
    throw new ReaderError('pdf_render_geometry', 'Изображение не соответствует запрошенной области', 422);
  }
  return { bytes, transform: { width: renderedWidth, height: renderedHeight, pixelsPerPoint, pixelOriginX, pixelOriginY } };
}

function textOutput(address: ReaderAddress, lines: ReaderLine[], empty: string): ReaderOutput {
  const limitations = lines.length ? [] : [empty];
  return {
    address, lines, limitations, mediaType: 'application/json',
    bytes: Buffer.from(JSON.stringify({ address, lines, limitations })),
  };
}

export function createPdfAdapter(options: { ocrLanguages?: string; profile?: string } = {}): ReaderAdapter {
  const languages = options.ocrLanguages ?? 'rus+eng';
  if (!/^[a-zA-Z0-9_]+(?:\+[a-zA-Z0-9_]+)*$/.test(languages)) throw new Error('Invalid OCR languages');
  let version: Promise<string> | undefined;
  return {
    format: 'pdf',
    version() {
      version ??= command('pdfinfo', ['-v'], 'pdf_inventory_version', 5000, true)
        .then(async (identification) => {
          const poppler = /pdfinfo version (\S+)/.exec(identification.toString('utf8'))?.[1];
          if (!poppler) throw new ReaderError('pdf_inventory_version_failed', 'Версия Poppler недоступна', 503);
          const ocr = await command('tesseract', ['--version'], 'pdf_ocr_version', 5000)
            .then((output) => /^tesseract (\S+)/.exec(output.toString('utf8'))?.[1] ?? 'unknown',
              () => 'unavailable');
          return `pdf-v1;poppler=${poppler};ocr=${ocr}:${languages};profile=${options.profile ?? 'local'}`;
        })
        .catch((error: unknown) => { version = undefined; throw error; });
      return version;
    },
    inspect,
    async read(path, request, unit, containedWords) {
      if (!unit.width || !unit.height) {
        throw new ReaderError('pdf_geometry_unavailable', 'Размер видимой страницы недоступен', 422);
      }
      const viewport: Box = { x: 0, y: 0, width: unit.width, height: unit.height };
      const box = request.address.box ?? viewport;
      if (!validBox(box) || !contains(viewport, box)
        || Object.entries(request.address.locator ?? {}).some(([key, value]) => unit.locator?.[key] !== value)) {
        throw new ReaderError('reader_address_invalid', 'Рамка выходит за границы видимой страницы', 422);
      }
      const page = unit.id;
      const address = { unitId: page, locator: unit.locator, ...(request.address.box ? { box } : {}) };
      if (request.representation === 'native') {
        const tsv = await command('pdftotext', ['-f', page, '-l', page, '-cropbox', '-enc', 'UTF-8', '-tsv', path, '-'], 'pdf_native');
        return textOutput(address, wordRows(tsv, 'native', box, undefined, containedWords), 'pdf_native_empty');
      }
      const desiredDpi = request.representation === 'ocr' ? 240 : request.address.box ? 288 : 144;
      const fitDpi = Math.floor(72 * Math.min((maxSide - 2) / Math.max(box.width, box.height),
        Math.sqrt((maxPixels - 2 * maxSide) / (box.width * box.height))));
      const dpi = request.dpi ?? Math.min(desiredDpi, fitDpi);
      if (!Number.isInteger(dpi) || dpi < 1 || dpi > maxDpi) {
        throw new ReaderError('pdf_render_limit', 'Недопустимое разрешение PDF', 422);
      }
      const image = await render(path, page, viewport, box, dpi);
      if (request.representation === 'render') return { address, ...image, mediaType: 'image/png' };
      const temp = await mkdtemp(join(tmpdir(), 'facade-pdf-ocr-'));
      try {
        const input = join(temp, 'fragment.png');
        await writeFile(input, image.bytes, { mode: 0o600 });
        const tsv = await command('tesseract', [input, 'stdout', '-l', languages, '--psm', '11', 'tsv'], 'pdf_ocr');
        return {
          ...textOutput(address, wordRows(tsv, 'ocr', box, image.transform), 'pdf_ocr_empty'),
          inputImage: image,
        };
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },
  };
}
