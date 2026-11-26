import { open } from 'node:fs/promises';
import sharp from 'sharp';
import { recognizeImage, tesseractLanguages, tesseractVersion } from '../pdf/pdf-adapter.js';
import { contains, ReaderError, validBox, type Box, type ImageTransform, type ReaderAdapter, type ReaderLine,
  type ReaderOutput } from '../pdf/types.js';
import { matchInventory, stampPhysicalInventory } from './physical-inventory.js';

const maxBytes = 128 * 1024 ** 2;
const maxPagePixels = 64_000_000;
const maxSide = 16_384;
const maxPages = 200;
const maxTotalPixels = 192_000_000;
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const tiffSignatures = new Set(['49492a00', '4d4d002a', '49492b00', '4d4d002b']);
const languages = 'rus+eng';

function decoder(path: string, page: number) {
  return sharp(path, { page, pages: 1, limitInputPixels: maxPagePixels, failOn: 'warning' });
}

async function sourceFormat(path: string) {
  const file = await open(path, 'r');
  try {
    if ((await file.stat()).size > maxBytes) {
      throw new ReaderError('raster_byte_limit', 'Превышен предел размера растрового файла', 422);
    }
    const { buffer, bytesRead } = await file.read(Buffer.alloc(8), 0, 8, 0);
    if (bytesRead === 8 && buffer.equals(png)) return 'png';
    if (bytesRead >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
    if (bytesRead >= 4 && tiffSignatures.has(buffer.toString('hex', 0, 4))) return 'tiff';
    throw new ReaderError('raster_signature_unsupported', 'Ожидается оригинал JPEG, PNG или TIFF', 415);
  } finally {
    await file.close();
  }
}

function invalidRaster(error: unknown): never {
  if (error instanceof ReaderError) throw error;
  const message = error instanceof Error ? error.message : '';
  if (/pixel limit/i.test(message)) throw new ReaderError('raster_dimension_limit', 'Превышен предел размеров растровой страницы', 422);
  if (/timeout|time limit/i.test(message)) throw new ReaderError('raster_decode_limit', 'Достигнут предел времени декодирования растра', 422);
  throw new ReaderError('raster_invalid_or_unreadable', 'Растровый файл повреждён или не декодируется', 422);
}

type Image = { bytes: Buffer; transform: ImageTransform; box: Box };

async function render(path: string, page: number, box: Box, dpi: number | undefined, ocr: boolean): Promise<Image> {
  // Pixel rectangles stay within the requested area, including fractional tool coordinates.
  const left = Math.ceil(box.x), top = Math.ceil(box.y);
  const width = Math.floor(box.x + box.width) - left, height = Math.floor(box.y + box.height) - top;
  if (width < 1 || height < 1) throw new ReaderError('raster_crop_limit', 'Рамка должна содержать хотя бы один пиксель оригинала', 422);
  const longest = ocr ? 4096 : 2048;
  const target = Math.min((dpi ?? (ocr ? 144 : 72)) / 72, ocr ? 2 : 1,
    longest / Math.max(width, height), Math.sqrt((ocr ? 8_000_000 : 4_000_000) / (width * height)));
  const axis = width >= height ? 'width' : 'height';
  const length = Math.max(1, Math.floor(Math.max(width, height) * target));
  const crop = decoder(path, page).autoOrient().extract({ left, top, width, height });
  if (length !== Math.max(width, height)) crop.resize({ [axis]: length });
  try {
    const { data, info } = await crop.flatten({ background: '#ffffff' }).toColourspace('srgb')
      .png({ compressionLevel: 3 }).timeout({ seconds: 12 }).toBuffer({ resolveWithObject: true });
    const pixelsPerPoint = info[axis] / (axis === 'width' ? width : height);
    return { bytes: data, box: { x: left, y: top, width, height }, transform: {
      width: info.width, height: info.height, pixelsPerPoint, pixelOriginX: left * pixelsPerPoint, pixelOriginY: top * pixelsPerPoint,
    } };
  } catch (error) {
    invalidRaster(error);
  }
}

export function createRasterAdapter(): ReaderAdapter {
  const ocrTools = async () => {
    const stage = 'raster_ocr_version';
    const [version, installed] = await Promise.all([tesseractVersion(stage), tesseractLanguages(stage).catch(() => new Set<string>())]);
    return languages.split('+').every((language) => installed.has(language)) ? version : 'unavailable';
  };
  let ocrProfile: ReturnType<typeof ocrTools> | undefined;
  const getOcrProfile = () => ocrProfile ??= ocrTools();
  const version = async () => `raster-v1:sharp=${sharp.versions.sharp}:vips=${sharp.versions.vips}:ocr=${await getOcrProfile()}:${languages}`;

  return {
    format: 'image',
    version,
    async inspect(path, source) {
      const format = await sourceFormat(path);
      try {
        const first = await decoder(path, 0).metadata();
        const pages = format === 'tiff' ? first.pages ?? 1 : 1;
        if (!Number.isSafeInteger(pages) || pages < 1 || pages > maxPages) {
          throw new ReaderError('raster_page_limit', 'Превышен предел числа растровых страниц', 422);
        }
        const units = [];
        let totalPixels = 0;
        const deadline = Date.now() + 45_000;
        for (let index = 0; index < pages; index++) {
          const current = decoder(path, index);
          const metadata = index === 0 ? first : await current.metadata();
          if (metadata.format !== format) throw new ReaderError('raster_signature_mismatch', 'Байты не соответствуют формату растра', 422);
          const { width, height } = metadata.autoOrient;
          totalPixels += width * height;
          if (![width, height].every((side) => Number.isSafeInteger(side) && side > 0 && side <= maxSide) ||
            width * height > maxPagePixels || totalPixels > maxTotalPixels) {
            throw new ReaderError('raster_dimension_limit', 'Превышен предел размеров растровых страниц', 422);
          }
          // A header alone cannot prove the pixels or later TIFF pages are readable.
          const seconds = Math.min(12, Math.floor((deadline - Date.now()) / 1000));
          if (seconds < 1) throw new ReaderError('raster_decode_limit', 'Достигнут предел времени декодирования растра', 422);
          await current.resize({ width: 1, height: 1, fit: 'fill', fastShrinkOnLoad: false })
            .raw().timeout({ seconds }).toBuffer();
          const page = index + 1;
          units.push({ id: String(page), width, height, locator: { page, rasterFormat: format } });
        }
        const expected = Array.from({ length: pages }, (_, index) => String(index + 1));
        return source ? stampPhysicalInventory(units, { units: [], originalSha256: source.sha256,
          inventory: matchInventory(expected, units.map(({ id }) => id), 'raster_inventory_mismatch') }, 'image', await version()) : units;
      } catch (error) {
        invalidRaster(error);
      }
    },
    async read(path, request, unit): Promise<ReaderOutput> {
      const { width, height } = unit;
      const page = unit.locator?.page;
      if (!width || !height || typeof page !== 'number') {
        throw new ReaderError('raster_geometry_unavailable', 'Размер растровой страницы недоступен', 422);
      }
      const viewport = { x: 0, y: 0, width, height };
      const box = request.address.box ?? viewport;
      if (!validBox(box) || !contains(viewport, box) ||
        Object.entries(request.address.locator ?? {}).some(([key, value]) => unit.locator?.[key] !== value)) {
        throw new ReaderError('reader_address_invalid', 'Рамка выходит за границы растровой страницы', 422);
      }
      const address = { unitId: unit.id, locator: unit.locator, ...(request.address.box ? { box } : {}) };
      if (request.representation === 'render') {
        const { bytes, transform } = await render(path, page - 1, box, request.dpi, false);
        return { address, bytes, transform, mediaType: 'image/png' };
      }
      let image: Image | undefined;
      let lines: ReaderLine[] = [];
      let limitation = 'raster_ocr_empty';
      try {
        if (await getOcrProfile() === 'unavailable') {
          throw new ReaderError('raster_ocr_unavailable', 'Для распознавания растра нужны языки rus и eng', 503);
        }
        image = await render(path, page - 1, box, request.dpi, true);
        lines = (await recognizeImage(image, image.box, languages, 'raster_ocr'))
          .map((line) => ({ ...line, details: { textLayer: 'ocr' } }));
      } catch (error) {
        if (!(error instanceof ReaderError) || !error.code.startsWith('raster_ocr_') || request.representation !== 'native') throw error;
        limitation = error.code;
      }
      const limitations = lines.length ? [] : [limitation];
      return { address, lines, limitations, mediaType: 'application/json',
        bytes: Buffer.from(JSON.stringify({ address, lines, limitations })),
        ...(image ? { inputImage: { bytes: image.bytes, transform: image.transform } } : {}) };
    },
  };
}
