import type { ReaderUnit } from "../pdf/types.js";

export const dwgReaderProfile = "formats-1.1.9-oda";
export const historicalDwgReaderProfile = "formats-1.1.8";
export const dxfFramingRevision = "eol1";
export const dxfEncodingRevision = "cp1251r1";

type DwgReaderProfile = typeof dwgReaderProfile | typeof historicalDwgReaderProfile;
const profiles = [dwgReaderProfile, historicalDwgReaderProfile] as const;
const retrySuffix = `-dxf-${dxfFramingRevision}`;
const encodingSuffix = `-dxf-${dxfEncodingRevision}`;
const recoverySuffixes = [retrySuffix, encodingSuffix];
const versionPin = new RegExp(`^(${profiles.map(profile => profile.replaceAll(".", "\\.")).join("|")})`
  + `(${recoverySuffixes.join("|")})?:dwg:(sha256:[a-f0-9]{64}):fonts:sha256:([a-f0-9]{64})$`);
export const dxfRecoveryVersionPatterns = profiles.flatMap(profile =>
  recoverySuffixes.map(suffix => `${profile}${suffix}:dwg:%`));

export function parseDwgVersion(readerVersion: string | null | undefined) {
  const pin = readerVersion?.match(versionPin);
  if (pin) return { profile: pin[1] as DwgReaderProfile, revision: pin[2], converter: pin[3], fonts: pin[4] };
}

export function isOdaDwgVersion(readerVersion: string) {
  return parseDwgVersion(readerVersion)?.profile === dwgReaderProfile;
}

function recoveryVersion(readerVersion: string | null, suffix: string): string | null {
  const pin = parseDwgVersion(readerVersion);
  return readerVersion && pin && !pin.revision
    ? pin.profile + suffix + readerVersion.slice(pin.profile.length) : null;
}

export function dxfGroupRecoveryVersion(readerVersion: string | null): string | null {
  return recoveryVersion(readerVersion, retrySuffix);
}

export function isDxfRecoveryVersion(readerVersion: string | null): boolean {
  return Boolean(parseDwgVersion(readerVersion)?.revision);
}

export function dxfEncodingRecoveryVersion(readerVersion: string | null): string | null {
  return recoveryVersion(readerVersion, encodingSuffix);
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

export function isOdaRejection(units: readonly ReaderUnit[]): boolean {
  return isDwgHold(units, "converter_oda_rejected");
}

function isDwgHold(units: readonly ReaderUnit[], reason: string): boolean {
  const [unit] = units;
  return units.length === 1 && unit.id === "original" && unit.locator?.coverage === "held"
    && unit.locator?.limitations === reason;
}
