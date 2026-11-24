import { posix } from "node:path";
import { crc32 } from "node:zlib";
import { SaxesParser } from "saxes";
import type { SaxesTagNS } from "saxes";
import { fromBuffer } from "yauzl";
import type { ZipFile } from "yauzl";
import { FormatHold } from "./model.js";

export type Element = {
  name: string;
  namespace: string;
  attributes: Record<string, string>;
  children: Element[];
  value: string;
};

const namespaces = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://schemas.openxmlformats.org/package/2006/relationships",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
  "http://purl.oclc.org/ooxml/spreadsheetml/main",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
]);

function element(tag: SaxesTagNS): Element {
  const attributes: Record<string, string> = Object.create(null);
  for (const { local, uri, value } of Object.values(tag.attributes)) {
    if (!uri || namespaces.has(uri)) attributes[local] = value;
  }
  return { name: namespaces.has(tag.uri) ? tag.local : tag.name, namespace: tag.uri, attributes, children: [], value: "" };
}

export function xml(buf: Buffer): Element {
  const input = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  const parser = new SaxesParser({ xmlns: true });
  const document: Element = { name: "", namespace: "", attributes: {}, children: [], value: "" };
  const stack = [document];
  let nodes = 0;
  parser.on("doctype", () => { throw new FormatHold("ooxml_dtd_forbidden"); });
  parser.on("opentag", (tag) => {
    if (++nodes > 140_000 || stack.length > 96) throw new FormatHold("ooxml_xml_limit");
    const node = element(tag);
    stack.at(-1)!.children.push(node);
    stack.push(node);
  });
  parser.on("closetag", () => { stack.pop(); });
  const append = (value: string) => { stack.at(-1)!.value += value; };
  parser.on("text", append);
  parser.on("cdata", append);
  parser.write(input).close();
  return document.children[0];
}

export const children = (el: Element | undefined, name: string): Element[] =>
  el?.children.filter((child) => child.name === name) ?? [];
export const child = (el: Element | undefined, name: string): Element | undefined =>
  el?.children.find((child) => child.name === name);
export const attr = (el: Element | undefined, name: string): string | undefined => el?.attributes[name];

export function* elements(root: Element): Generator<Element> {
  yield root;
  for (const entry of root.children) yield* elements(entry);
}

export function relationships(root: Element | undefined, owner: string) {
  const entries = new Map<string, { path: string; type: string; external: boolean }>();
  for (const relation of children(root, "Relationship")) {
    const { Id, Type, Target, TargetMode } = relation.attributes;
    if (!Id || !Type || !Target || entries.has(Id)) throw new FormatHold("ooxml_relationship_invalid");
    const external = TargetMode === "External";
    const path = Target.startsWith("/") ? posix.normalize(Target.slice(1))
      : posix.normalize(posix.join(posix.dirname(owner), Target));
    if (!external && (path.startsWith("../") || path === ".." || path.includes("\\"))) {
      throw new FormatHold("ooxml_relationship_invalid");
    }
    entries.set(Id, { path, type: Type, external });
  }
  return entries;
}

async function openZip(input: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    fromBuffer(input, { lazyEntries: true, strictFileNames: true }, (error, archive) => {
      if (error) reject(error);
      else resolve(archive);
    });
  });
}

export async function unpackXml(input: Buffer, include: (name: string) => boolean, paths?: Set<string>) {
  const entries = new Map<string, Element>();
  const zip = await openZip(input);
  try {
    if (zip.entryCount > 4096) throw new FormatHold("ooxml_entry_limit");
    let selectedBytes = 0;
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.once("end", resolve);
      zip.on("entry", (entry) => {
        if (paths?.has(entry.fileName)) {
          reject(new FormatHold("ooxml_duplicate_part"));
          return;
        }
        paths?.add(entry.fileName);
        if (!include(entry.fileName)) {
          zip.readEntry();
          return;
        }
        selectedBytes += entry.uncompressedSize;
        if (selectedBytes > 24 * 1024 * 1024 || entry.uncompressedSize > 6 * 1024 * 1024) {
          reject(new FormatHold("ooxml_expanded_limit"));
          return;
        }
        if (entries.has(entry.fileName)) {
          reject(new FormatHold("ooxml_duplicate_part"));
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            reject(error);
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (data: Buffer) => { chunks.push(data); });
          stream.once("error", reject);
          stream.once("end", () => {
            try {
              const bytes = Buffer.concat(chunks);
              if (crc32(bytes) !== entry.crc32) throw new FormatHold("ooxml_crc_mismatch");
              entries.set(entry.fileName, xml(bytes));
              zip.readEntry();
            } catch (cause) {
              reject(cause);
            }
          });
        });
      });
      zip.readEntry();
    });
    return entries;
  } finally {
    zip.close();
  }
}
