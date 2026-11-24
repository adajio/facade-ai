import { lookup } from "node:dns/promises";
import { Agent, get } from "node:https";
import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { BlockList, isIPv4, Socket } from "node:net";
import type { LookupFunction } from "node:net";
import { ImportIssue, importLimits, safeRelativePath } from "./policy.js";

const apiHost = "cloud-api.yandex.net";
const apiRoot = `https://${apiHost}/v1/disk/public/resources`;
const shareHosts = new Set(["disk.yandex.ru", "disk.yandex.com", "yadi.sk"]);
const downloadHosts = new Set(["downloader.disk.yandex.ru", "downloader.disk.yandex.net"]);
const redirectCodes = new Set([301, 302, 303, 307, 308]);
const forbiddenIpv4 = new BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) forbiddenIpv4.addSubnet(prefix, bits, "ipv4");

function permittedHttps(url: URL, hosts: ReadonlySet<string>): boolean {
  return url.protocol === "https:" && !url.username && !url.password &&
    !url.port && !url.hash && hosts.has(url.hostname);
}

export function publicShare(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new ImportIssue("invalid_public_url");
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ImportIssue("invalid_public_url"); }
  if (!permittedHttps(url, shareHosts) ||
    !/^\/(?:d|i)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) || url.search) {
    throw new ImportIssue("unsupported_public_url");
  }
  return url.href;
}

type Request = (url: URL, hosts: ReadonlySet<string>, signal: AbortSignal) =>
  Promise<IncomingMessage>;

export function selectPublicIpv4(addresses: readonly { address: string }[]): string {
  const address = addresses[0]?.address;
  if (!address || addresses.some(record => !isIPv4(record.address) ||
    forbiddenIpv4.check(record.address, "ipv4"))) {
    throw new ImportIssue("remote_destination_rejected");
  }
  return address;
}

function proxyEndpoint(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" && url.hostname && !url.username && !url.password &&
      url.pathname === "/" && !url.search && !url.hash) return url;
  } catch { /* Configuration values are never returned in diagnostics. */ }
  throw new ImportIssue("import_proxy_invalid");
}

async function connectProxy(endpoint: URL, host: string, signal: AbortSignal): Promise<Duplex> {
  const authority = `${host}:443`;
  return new Promise((resolve, reject) => {
    const req = request(endpoint, {
      method: "CONNECT", path: authority, headers: { Host: authority }, agent: false, signal,
    });
    req.once("connect", (response, socket, head) => {
      if (socket instanceof Socket) socket.setTimeout(0);
      if (response.statusCode === 200 && !head.length) {
        resolve(socket);
      } else {
        socket.destroy();
        reject(response.statusCode === 403
          ? new ImportIssue("remote_destination_rejected")
          : new ImportIssue("remote_unreachable", true));
      }
    });
    req.once("response", response => {
      response.destroy();
      reject(new ImportIssue("remote_unreachable", true));
    });
    req.once("error", () => reject(new ImportIssue("remote_unreachable", true)));
    req.setTimeout(10_000, () => req.destroy());
    req.end();
  });
}

async function requestPublic(url: URL, hosts: ReadonlySet<string>, signal: AbortSignal) {
  if (!permittedHttps(url, hosts)) throw new ImportIssue("remote_destination_rejected");
  const proxy = process.env.FACADE_IMPORT_HTTPS_PROXY;
  let agent: Agent | false = false;
  let directLookup: LookupFunction | undefined;
  if (proxy) {
    // The allowlisted proxy resolves and pins the public address. TLS stays end to end.
    const socket = await connectProxy(proxyEndpoint(proxy), url.hostname, signal);
    if (signal.aborted) {
      socket.destroy();
      throw signal.reason;
    }
    const tunnelAgent = new Agent({ keepAlive: false });
    tunnelAgent.createConnection = () => tlsConnect({
      socket, servername: url.hostname, rejectUnauthorized: true,
    });
    agent = tunnelAgent;
  } else {
    let addresses;
    try { addresses = await lookup(url.hostname, { family: 4, all: true }); }
    catch { throw new ImportIssue("remote_unreachable", true); }
    signal.throwIfAborted();
    const address = selectPublicIpv4(addresses);
    directLookup = (_hostname, _options, callback) => callback(null, address, 4);
  }

  const cleanup = () => agent && agent.destroy();
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = get(url, {
      agent, signal,
      ...(directLookup ? { family: 4, lookup: directLookup } : {}),
      headers: { "Accept-Encoding": "identity" },
    }, response => {
      response.once("close", cleanup);
      resolve(response);
    });
    req.setTimeout(30_000, () => req.destroy());
    req.on("error", () => {
      cleanup();
      reject(new ImportIssue("remote_unreachable", true));
    });
  });
}

function errorCode(status: number, remoteCode: unknown): ImportIssue {
  if (typeof remoteCode === "string") {
    if (/password/i.test(remoteCode)) return new ImportIssue("remote_password_required");
    if (/revoked|unpublished/i.test(remoteCode)) return new ImportIssue("remote_revoked");
  }
  if (status === 410) return new ImportIssue("remote_revoked");
  if (status === 429 || status >= 500) return new ImportIssue("remote_unavailable", true);
  return new ImportIssue("remote_inaccessible");
}

async function readJson(response: IncomingMessage): Promise<unknown> {
  const buffers: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of response) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 1024 ** 2) throw new ImportIssue("remote_metadata_limit");
      buffers.push(bytes);
    }
  } catch (error) {
    if (error instanceof ImportIssue) throw error;
    throw new ImportIssue("remote_transfer_interrupted", true);
  }
  try { return JSON.parse(Buffer.concat(buffers).toString("utf8")) as unknown; }
  catch { return null; }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImportIssue("remote_metadata_invalid");
  }
  return value as Record<string, unknown>;
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export type RemoteEntry = {
  path: string;
  remotePath: string;
  kind: "directory" | "file";
  size: number;
  sha256: string | null;
  mediaType: string | null;
  parent: number | null;
  restriction?: string;
};

export interface PublicDisk {
  manifest(url: string, signal: AbortSignal): Promise<RemoteEntry[]>;
  download(url: string, entry: RemoteEntry, signal: AbortSignal): Promise<IncomingMessage>;
}

export class YandexDisk implements PublicDisk {
  constructor(private readonly send: Request = requestPublic) {}

  private async open(url: URL, hosts: ReadonlySet<string>, signal: AbortSignal) {
    for (let redirect = 0; redirect <= 4; redirect++) {
      signal.throwIfAborted();
      if (!permittedHttps(url, hosts)) throw new ImportIssue("remote_destination_rejected");
      const response = await this.send(url, hosts, signal);
      if (!redirectCodes.has(response.statusCode ?? 0)) return response;
      response.destroy();
      const location = response.headers.location;
      if (!location || redirect === 4) throw new ImportIssue("remote_redirect_limit");
      try { url = new URL(location, url); }
      catch { throw new ImportIssue("remote_destination_rejected"); }
    }
    throw new ImportIssue("remote_redirect_limit");
  }

  private async metadata(share: string, signal: AbortSignal, path?: string, offset = 0, download = false) {
    const url = new URL(apiRoot + (download ? "/download" : ""));
    url.searchParams.set("public_key", share);
    if (path !== undefined) url.searchParams.set("path", path);
    if (!download) {
      url.searchParams.set("limit", "100");
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("sort", "name");
      url.searchParams.set("fields", "name,type,size,sha256,mime_type,_embedded.total,_embedded.items.name,_embedded.items.type,_embedded.items.size,_embedded.items.sha256,_embedded.items.mime_type");
    }
    const response = await this.open(url, new Set([apiHost]), signal);
    const status = response.statusCode ?? 0;
    const body = await readJson(response);
    if (status !== 200) {
      const bodyError = body && typeof body === "object" && "error" in body ? body.error : undefined;
      throw errorCode(status, bodyError);
    }
    return record(body);
  }

  async manifest(share: string, signal: AbortSignal): Promise<RemoteEntry[]> {
    const entries: RemoteEntry[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    const add = (value: Record<string, unknown>, parent: number | null): RemoteEntry => {
      if (entries.length >= importLimits.sourceEntries) throw new ImportIssue("source_entry_limit");
      if (typeof value.name !== "string" || /[\\/]/.test(value.name)) {
        throw new ImportIssue("invalid_source_path");
      }
      const name = safeRelativePath(value.name);
      const folder = parent === null ? undefined : entries[parent];
      const path = folder ? safeRelativePath(`${folder.path}/${name}`) : name;
      const remotePath = folder ? `${folder.remotePath}/${name}` : "";
      if (seen.has(remotePath)) throw new ImportIssue("remote_inventory_changed");
      seen.add(remotePath);
      if (value.type !== "dir" && value.type !== "file") {
        throw new ImportIssue("remote_metadata_invalid");
      }
      if (value.type === "file" && !nonnegative(value.size)) {
        throw new ImportIssue("remote_metadata_invalid");
      }
      const size = value.type === "file" ? value.size as number : 0;
      totalBytes += size;
      if (totalBytes > importLimits.sourceBytes) throw new ImportIssue("source_byte_limit");
      const entry: RemoteEntry = {
        path, remotePath, parent, size, kind: value.type === "dir" ? "directory" : "file",
        sha256: typeof value.sha256 === "string" && /^[0-9a-f]{64}$/i.test(value.sha256)
          ? value.sha256.toLowerCase() : null,
        mediaType: typeof value.mime_type === "string" && value.mime_type.length <= 255
          ? value.mime_type : null,
      };
      entries.push(entry);
      return entry;
    };
    const root = await this.metadata(share, signal);
    add(root, null);
    for (let parent = 0; parent < entries.length; parent++) {
      const folder = entries[parent];
      if (folder?.kind !== "directory") continue;
      try {
        if (folder.path.split("/").length > importLimits.folderDepth) {
          folder.restriction = "source_folder_depth_limit";
          continue;
        }
        let page = folder.remotePath ? await this.metadata(share, signal, folder.remotePath) : root;
        let offset = 0;
        let originalTotal: number | undefined;
        while (true) {
          const embedded = record(page._embedded);
          const items = embedded.items;
          const total = embedded.total;
          if (!Array.isArray(items) || items.length > 100 || !nonnegative(total) ||
            offset + items.length > total || (originalTotal !== undefined && originalTotal !== total)) {
            throw new ImportIssue("remote_inventory_changed");
          }
          originalTotal = total;
          for (const value of items) add(record(value), parent);
          offset += items.length;
          if (offset === total) break;
          if (!items.length) throw new ImportIssue("remote_inventory_changed");
          page = await this.metadata(share, signal, folder.remotePath || undefined, offset);
        }
      } catch (error) {
        if (!(error instanceof ImportIssue) ||
          !["remote_password_required", "remote_revoked", "remote_inaccessible"].includes(error.code) ||
          folder.parent === null) throw error;
        folder.restriction = error.code;
      }
    }
    return entries;
  }

  async download(share: string, entry: RemoteEntry, signal: AbortSignal): Promise<IncomingMessage> {
    const link = await this.metadata(share, signal, entry.remotePath || undefined, 0, true);
    let url: URL;
    try {
      if (typeof link.href !== "string" || link.href.length > 8192 || link.method !== "GET" ||
        link.templated !== false) throw new Error();
      url = new URL(link.href);
    } catch { throw new ImportIssue("remote_metadata_invalid"); }
    const response = await this.open(url, downloadHosts, signal);
    if (response.statusCode !== 200 || ![undefined, "identity"].includes(response.headers["content-encoding"])) {
      response.destroy();
      throw errorCode(response.statusCode ?? 0, undefined);
    }
    return response;
  }
}
