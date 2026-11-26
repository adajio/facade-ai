import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { thumbnailCacheFixture } from '../../../src/modules/formats/test/fixtures/windows-thumbnail-cache.mjs';

const formatFixture = (name) => new URL(`../../../src/modules/formats/test/fixtures/${name}`, import.meta.url);
const signedPdf = new URL('../../../test/fixtures/input/facade-package.pdf', import.meta.url);

export async function mixedInputs(runDir) {
  const directory = join(runDir, 'intake-input');
  const signing = join(runDir, 'signing');
  await mkdir(directory, { mode: 0o700 });
  await mkdir(signing, { mode: 0o700 });
  const key = join(signing, 'key.pem'), cert = join(signing, 'cert.pem');
  const quiet = { stdio: 'ignore', timeout: 15_000 };
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=Facade Synthetic Release Rehearsal', '-keyout', key, '-out', cert], quiet);
  for (const [name, options] of [['brief.pdf.sig', ['-nodetach']], ['detached.sig', []]]) {
    execFileSync('openssl', ['cms', '-sign', '-binary', ...options, '-in', fileURLToPath(signedPdf),
      '-signer', cert, '-inkey', key, '-outform', 'DER', '-out', join(directory, name)], quiet);
  }
  const jpeg = '<svg xmlns="http://www.w3.org/2000/svg" width="880" height="420">' +
    '<rect width="880" height="420" fill="white"/>' +
    '<text x="100" y="140" font-size="64" font-family="DejaVu Sans, sans-serif">FACADE NORTH</text>' +
    '<text x="100" y="245" font-size="64" font-family="DejaVu Sans, sans-serif">FACADE RIB 42 MM</text></svg>';
  await Promise.all([
    sharp(Buffer.from(jpeg)).jpeg({ quality: 94 }).toFile(join(directory, 'north.jpg')),
    sharp({ create: { width: 180, height: 120, channels: 3, background: '#829db5' } }).png().toFile(join(directory, 'colour-swatch.png')),
    copyFile(formatFixture('mixed-raster.pdf'), join(directory, 'scan.pdf')),
    copyFile(formatFixture('schedule.doc'), join(directory, 'schedule.doc')),
    copyFile(formatFixture('unreadable.doc'), join(directory, 'unreadable.doc')),

    copyFile(new URL('mtext.dwg', import.meta.url), join(directory, 'mtext.dwg')),
    writeFile(join(directory, 'Thumbs.db'), thumbnailCacheFixture()),
  ]);
  return directory;
}
