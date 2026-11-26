import type { ReaderUnit } from "../pdf/types.js";

export const dwgReaderProfile = "formats-1.1.8";
export const dxfFramingRevision = "eol1";
const retrySuffix = `-dxf-${dxfFramingRevision}`;
const retryProfile = dwgReaderProfile + retrySuffix;
export const dxfGroupRecoveryVersionPattern = `${retryProfile}:dwg:%`;
const pin = ":dwg:(sha256:[a-f0-9]{64}):fonts:sha256:([a-f0-9]{64})$";
const base = new RegExp(`^${dwgReaderProfile.replaceAll(".", "\\.")}${pin}`);
const retry = new RegExp(`^${retryProfile.replaceAll(".", "\\.")}${pin}`);
export const dwgVersionPin = new RegExp(`^${dwgReaderProfile.replaceAll(".", "\\.")}(?:${retrySuffix})?${pin}`);

export function dxfGroupRecoveryVersion(readerVersion: string | null): string | null {
  return readerVersion && base.test(readerVersion)
    ? retryProfile + readerVersion.slice(dwgReaderProfile.length) : null;
}

export function isDxfGroupRecoveryVersion(readerVersion: string | null): boolean {
  return Boolean(readerVersion && retry.test(readerVersion));
}

export const legacyDxfGroupHold = [{
  id: "original",
  locator: { coverage: "held", limitations: "dxf_group_invalid" },
}] as const;

export function isDxfGroupHold(units: readonly ReaderUnit[]): boolean {
  const [unit] = units;
  const [pattern] = legacyDxfGroupHold;
  return units.length === 1 && unit.id === pattern.id && unit.locator?.coverage === pattern.locator.coverage
    && unit.locator?.limitations === pattern.locator.limitations;
}
