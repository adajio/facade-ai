import type { ReaderUnit } from "../pdf/types.js";

export const dwgReaderProfile = "formats-1.1.8";
export const dxfFramingRevision = "eol1";
const retrySuffix = `-dxf-${dxfFramingRevision}`;
const retryProfile = dwgReaderProfile + retrySuffix;
export const dxfEncodingRevision = "cp1251r1";
const encodingSuffix = `-dxf-${dxfEncodingRevision}`;
const encodingProfile = dwgReaderProfile + encodingSuffix;
export const dxfRecoveryVersionPatterns = [`${retryProfile}:dwg:%`, `${encodingProfile}:dwg:%`];
const pin = ":dwg:(sha256:[a-f0-9]{64}):fonts:sha256:([a-f0-9]{64})$";
const base = new RegExp(`^${dwgReaderProfile.replaceAll(".", "\\.")}${pin}`);
const retry = new RegExp(`^${dwgReaderProfile.replaceAll(".", "\\.")}(?:${retrySuffix}|${encodingSuffix})${pin}`);
export const dwgVersionPin = new RegExp(`^${dwgReaderProfile.replaceAll(".", "\\.")}(?:${retrySuffix}|${encodingSuffix})?${pin}`);

export function dxfGroupRecoveryVersion(readerVersion: string | null): string | null {
  return readerVersion && base.test(readerVersion)
    ? retryProfile + readerVersion.slice(dwgReaderProfile.length) : null;
}

export function isDxfRecoveryVersion(readerVersion: string | null): boolean {
  return Boolean(readerVersion && retry.test(readerVersion));
}

export function dxfEncodingRecoveryVersion(readerVersion: string | null): string | null {
  return readerVersion && base.test(readerVersion)
    ? encodingProfile + readerVersion.slice(dwgReaderProfile.length) : null;
}

export const legacyDxfEncodingHold = [{
  id: "original",
  locator: { coverage: "held", limitations: "text_encoding_unconfirmed" },
}] as const;

export const legacyDxfGroupHold = [{
  id: "original",
  locator: { coverage: "held", limitations: "dxf_group_invalid" },
}] as const;

export function isDxfGroupHold(units: readonly ReaderUnit[]): boolean {
  return isDwgHold(units, legacyDxfGroupHold[0].locator.limitations);
}

export function isDxfEncodingHold(units: readonly ReaderUnit[]): boolean {
  return isDwgHold(units, legacyDxfEncodingHold[0].locator.limitations);
}

function isDwgHold(units: readonly ReaderUnit[], reason: string): boolean {
  const [unit] = units;
  return units.length === 1 && unit.id === "original" && unit.locator?.coverage === "held"
    && unit.locator?.limitations === reason;
}
