import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The producer may be mounted independently of the server source tree.
const moduleUrl = process.env.FACADE_SOURCE_ROOT
  ? pathToFileURL(join(process.env.FACADE_SOURCE_ROOT,'dist/src/modules/intake/drawing-alternatives.js')).href
  : new URL('../../src/modules/intake/drawing-alternatives.ts',import.meta.url).href;
export const { deriveDrawingAlternatives } = await import(moduleUrl);
