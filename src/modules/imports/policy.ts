const GiB = 1024 ** 3;

export const importLimits = {
  sourceBytes: 10 * GiB,
  sourceEntries: 10_000,
  folderDepth: 32,
  archiveDepth: 5,
  archiveEntries: 10_000,
  expandedBytes: 10 * GiB,
  archiveTimeoutMs: 30 * 60_000,
  archiveMemoryBytes: GiB,
  directUploadAvailable: true,
};

export class ImportIssue extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable = false,
    public readonly statusCode = 422,
  ) {
    super(code);
  }
}

/** Provenance uses this spelling, never a local filesystem destination. */
export function safeRelativePath(value: string): string {
  if (!value || Buffer.byteLength(value) > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ImportIssue("invalid_source_path");
  }
  const path = value.replaceAll("\\", "/");
  if (/^[A-Za-z]:/.test(path) ||
    path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new ImportIssue("invalid_source_path");
  }
  return path;
}

export function archiveFormat(path: string, mediaType?: string | null): "zip" | "rar" | "7z" | null {
  // Office and OpenDocument files remain reader inputs despite their ZIP packaging.
  if (/\.(?:docx|docm|xlsx|xlsm|pptx|pptm|odt|ods|odp)$/i.test(path)) return null;
  const mime = mediaType?.split(";")[0]?.trim().toLowerCase();
  if (mime === "application/zip" || mime === "application/x-zip-compressed") return "zip";
  if (mime === "application/vnd.rar" || mime === "application/x-rar-compressed") return "rar";
  if (mime === "application/x-7z-compressed") return "7z";
  const ext = /\.(zip|rar|7z)$/i.exec(path)?.[1]?.toLowerCase();
  return ext === "zip" || ext === "rar" || ext === "7z" ? ext : null;
}
