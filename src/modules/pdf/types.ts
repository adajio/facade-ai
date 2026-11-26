import type { Readable } from 'node:stream';
import type { PoolClient } from 'pg';

export interface DocumentKey {
  projectId: string;
  documentId: string;
  versionId: string;
}

export interface SourceRef extends DocumentKey {
  sha256: string;
}

export interface Original extends SourceRef {
  receiptId: string;
  format: string;
  size: number;
  relativePath?: string;
  check?(): Promise<void>;
  open(): Promise<Readable>;
}

export type ResolveOriginal = (document: DocumentKey, tx?: PoolClient) => Promise<Original | null>;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReaderUnit {
  id: string;
  label?: string;
  width?: number;
  height?: number;
  locator?: Record<string, string | number>;
}

export interface ReaderAddress {
  unitId: string;
  box?: Box;
  locator?: Record<string, string | number>;
}

export type Representation = 'render' | 'native' | 'ocr';

export interface ReadRequest {
  address: ReaderAddress;
  representation: Representation;
  dpi?: number;
  query?: string;
  readerVersion?: string;
}

export interface ReaderLine {
  id: string;
  text: string;
  box?: Box;
  locator?: Record<string, string | number>;
  details?: Record<string, unknown>;
  drawingBounds?: Box;
}

export interface ImageTransform {
  width: number;
  height: number;
  pixelsPerPoint: number;
  pixelOriginX: number;
  pixelOriginY: number;
}

export interface ReaderOutput {
  address: ReaderAddress;
  bytes: Buffer;
  mediaType: 'application/json' | 'image/png' | 'image/jpeg' | 'image/webp';
  lines?: ReaderLine[];
  transform?: ImageTransform;
  limitations?: string[];
  /** The exact image provided to local OCR, when applicable. */
  inputImage?: {
    bytes: Buffer;
    transform: ImageTransform;
  };
}

export interface ReaderAdapter {
  format: string;
  version(): Promise<string>;
  inspect(path: string, source?: SourceRef): Promise<ReaderUnit[]>;
  durableInfo?(source: SourceRef, units: readonly ReaderUnit[], readerVersion: string): Promise<{ storageKey: string; sha256: string; size: number; format: 'dxf' | 'dwg-json'; converter: string } | undefined>;
  read(path: string, request: ReadRequest, unit: ReaderUnit, containedWords?: boolean, source?: SourceRef): Promise<ReaderOutput>;
  readCached?(source: SourceRef, request: ReadRequest, unit: ReaderUnit, readerVersion?: string): Promise<ReaderOutput | undefined>;
  readCachedNativeUnits?(source: SourceRef, units: readonly ReaderUnit[], readerVersion?: string): Promise<AsyncIterable<ReaderOutput | ReaderError> | undefined>;
  readNativeUnits?(path: string, units: readonly ReaderUnit[], source?: SourceRef): AsyncIterable<ReaderOutput | ReaderError>;
}

export interface NativePresentation {
  address: ReaderAddress;
  lines: ReaderLine[];
  limitations: string[];
}

export interface NativeArtifact { sha256: string; size: number }

export type NativeBlock = {
  ordinal: number;
  unit: ReaderUnit;
  presentation?: NativePresentation;
  artifact?: NativeArtifact;
  limitation?: string;
};

/** Private, immutable, content-addressed storage. A put must verify or atomically create the object. */
export interface ArtifactStore {
  put(projectId: string, sha256: string, bytes: Buffer): Promise<void>;
  get(projectId: string, sha256: string, size: number): Promise<Buffer>;
}

export interface PageMap {
  source: SourceRef;
  receiptId: string;
  readerVersion: string;
  format: string;
  units: ReaderUnit[];
}

export interface ReadScope {
  runId: string;
  branch: 'A' | 'B';
  operationKey: string;
}

export interface Evidence {
  id: string;
  source: SourceRef;
  receiptId: string;
  runId: string;
  branch: ReadScope['branch'];
  readerVersion: string;
  format: string;
  address: ReaderAddress;
  representation: Representation;
  mediaType: 'application/json' | 'image/png' | 'image/jpeg' | 'image/webp';
  sha256: string;
  size: number;
  transform?: ImageTransform;
  limitations: string[];
  relativePath?: string;
  inputImage?: { sha256: string; size: number; transform: ImageTransform };
  materializedBlockId?: string;
}

export interface DeliveryStatement {
  status: 'delivered' | 'not_delivered';
  item: string;
  context?: { lineId: string; quote: string };
}

export const componentRoles = ['value', 'unit', 'variant', 'revision', 'identifier', 'relationship'] as const;
export const componentLinks = ['same_row', 'column_header', 'source_context', 'shared_identifier', 'ifc_reference'] as const;
export interface ReaderComponentInput {
  role: typeof componentRoles[number];
  literal: string;
  quote: string;
  lineId: string;
  evidenceId: string;
  link: { kind: 'anchor' } | { kind: typeof componentLinks[number]; to: number };
}

export interface ReaderObservationComponent extends ReaderComponentInput {
  source: SourceRef;
  receiptId: string;
  readerVersion: string;
  address: ReaderAddress;
  evidenceHref: string;
  binding?: {
    kind: 'value_context' | 'column_header' | 'row_context' | 'variant_field' | 'context';
    lineId: string;
    text: string;
  };
}

export interface PinInput {
  evidenceId: string;
  scope: string | null;
  lineId?: string;
  quote?: string;
  value?: string;
  unit?: string;
  normalizedValue?: string | number;
  deliveryStatement?: DeliveryStatement;
  box?: Box;
  limitation?: string;
  alternatives?: string[];
}

export interface Observation extends PinInput {
  id: string;
  source: SourceRef;
  receiptId: string;
  readerVersion: string;
  runId: string;
  branch: ReadScope['branch'];
  address: ReaderAddress;
  grounding: 'text' | 'visual' | 'limited';
  components?: ReaderObservationComponent[];
}

export class ReaderError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) {
    super(message);
    this.name = 'ReaderError';
  }
}

export function validBox(box: Box): boolean {
  return Boolean(box) && [box.x, box.y, box.width, box.height].every(Number.isFinite)
    && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0
    && Number.isFinite(box.x + box.width) && Number.isFinite(box.y + box.height);
}

export function contains(outer: Box, inner: Box): boolean {
  const epsilon = 0.000001;
  return inner.x >= outer.x - epsilon && inner.y >= outer.y - epsilon
    && inner.x + inner.width <= outer.x + outer.width + epsilon
    && inner.y + inner.height <= outer.y + outer.height + epsilon;
}

export function intersect(left: Box, right: Box): Box | undefined {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const width = Math.min(left.x + left.width, right.x + right.width) - x;
  const height = Math.min(left.y + left.height, right.y + right.height) - y;
  if (width > 0 && height > 0) return { x, y, width, height };
}
