type Locator = Record<string, unknown>;

export type CadUnit = { id: string; label?: string; locator?: Record<string, string | number> };

export type ReaderMap = {
  source: { projectId: string; documentId: string; versionId: string; sha256: string };
  format: string;
  readerVersion: string;
  units: CadUnit[];
};

export type CadAddress = {
  part: string;
  entity?: string;
  partSha256?: string;
  derivativeSha256?: string;
};

export function cadEntity(locator?: Locator) {
  const handle = locator?.derivativeHandle;
  if (typeof handle === 'string' && /^[0-9A-F]{1,16}$/u.test(handle)) return 'h:' + handle;
  const ordinal = locator?.entityOrdinal;
  if (typeof ordinal === 'number' && Number.isSafeInteger(ordinal) && ordinal > 0) return 'o:' + ordinal;
}

export function cadAddress(part?: string, locator?: Locator): CadAddress | undefined {
  if (!part || !locator) return;
  const partSha256 = typeof locator.partSha256 === 'string' && /^[a-f0-9]{64}$/u.test(locator.partSha256) ? locator.partSha256 : undefined;
  const derivativeSha256 = typeof locator.derivativeSha256 === 'string' && /^[a-f0-9]{64}$/u.test(locator.derivativeSha256) ? locator.derivativeSha256 : undefined;
  const entity = cadEntity(locator);
  if (partSha256 || derivativeSha256 && entity) {
    return { part, entity, partSha256, derivativeSha256 };
  }
}
