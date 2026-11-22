import { IntakeError, invalid } from "./errors.js";
import { MAX_RECEIPT_BYTES } from "./blob.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid("invalid_id", "Expected UUID");
  return value.toLowerCase();
}

export function checksum(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) invalid("invalid_sha256", "Expected SHA-256 in hex");
  return value.toLowerCase();
}

export function parseSize(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid("invalid_size", "Expected integer byte length");
  if ((value as number) > MAX_RECEIPT_BYTES) throw new IntakeError(413, "receipt_size_limit", "Receipt exceeds the byte limit");
  return value as number;
}

export function parseScopeIds(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length === 0) invalid("invalid_scope_ids", "Expected a nonempty list of scopes");
  return [...new Set(value.map(uuid))].sort();
}

export function parsePath(value: unknown): string {
  if (
    typeof value !== "string" || !value || Buffer.byteLength(value) > 4096
    || /[\\\x00-\x1f\x7f]/.test(value) || /^[a-z]:/i.test(value)
    || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) invalid("unsafe_relative_path", "Expected a safe relative path");
  return value;
}

export function parseMediaType(value: unknown): string {
  if (value == null) return "application/octet-stream";
  if (typeof value !== "string" || value.length > 127 || !/^[a-z0-9][a-z0-9.+_-]*\/[a-z0-9][a-z0-9.+_-]*$/i.test(value)) {
    invalid("invalid_media_type", "Expected a media type without parameters");
  }
  return value.toLowerCase();
}
