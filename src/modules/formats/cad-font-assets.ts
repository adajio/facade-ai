import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ReaderError } from "../pdf/types.js";
import { shxFont } from "./cad-shx.js";
import { ttfFont } from "./cad-ttf.js";

type Asset =
  | { kind: "shx"; key: string; sha256: string; font: ReturnType<typeof shxFont> }
  | { kind: "ttf"; key: string; sha256: string; font: ReturnType<typeof ttfFont>; path: string; stamp: string };
export type CadFontAsset = Asset;
const safeName = /^[a-z0-9][a-z0-9_.-]{0,119}\.(?:ttf|shx)$/i;
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const stamp = (stats: ReturnType<typeof fstatSync>) =>
  [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(":");

function readAssets(configured?: string) {
  const list: Asset[] = [];
  const rejected = new Set<string>();
  const manifest = new Map<string, string>();
  if (configured) {
    const root = resolve(configured);
    // Resolve names from the configured directory only, never from a DXF value.
    const dir = (() => {
      try { return opendirSync(root); }
      catch (error) {
        if (!["ENOENT","ENOTDIR","EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        manifest.set("", "unavailable");
      }
    })();
    try {
      for (let seen = 0; ; seen++) {
        const entry = dir?.readSync();
        if (!entry) break;
        if (seen >= 256 || manifest.size >= 24) throw new Error("Too many DWG font assets");
        if (!safeName.test(entry.name)) continue;
        const key = entry.name.toLowerCase();
        if (manifest.has(key)) {
          manifest.set(key, "ambiguous");
          rejected.add(key);
          continue;
        }
        if (!entry.isFile()) {
          manifest.set(key, "not-regular");
          rejected.add(key);
          continue;
        }
        const path = join(root, entry.name);
        let fd: number | undefined;
        try {
          fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const stats = fstatSync(fd);
          if (!stats.isFile() || stats.size <= 0 || stats.size > 4 * 1024 ** 2) throw new RangeError("font size");
          const bytes = readFileSync(fd);
          const hash = sha(bytes);
          if (stamp(stats) !== stamp(fstatSync(fd)) || stats.size !== bytes.length) throw new RangeError("font changed");
          if (key.endsWith(".shx")) list.push({ kind: "shx", key, sha256: hash, font: shxFont(bytes) });
          else list.push({ kind: "ttf", key, sha256: hash, font: ttfFont(bytes), path, stamp: stamp(stats) });
          manifest.set(key, hash);
        } catch (error) {
          if (!(error instanceof RangeError) && !(error as NodeJS.ErrnoException).code) throw error;
          manifest.set(key, "unreadable");
          rejected.add(key);
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
      }
    } finally {
      dir?.closeSync();
    }
  }
  const assets = list.filter(a => !rejected.has(a.key));
  // Resvg resolves family/style, not a file name. Ambiguous duplicate faces
  // are held instead of claiming one file was the one Resvg selected.
  const faces = new Set<string>(), duplicates = new Set<string>();
  const face = (a: Extract<Asset, { kind: "ttf" }>) => JSON.stringify([a.font.family.toLowerCase(), a.font.bold, a.font.italic]);
  for (const asset of assets) {
    if (asset.kind !== "ttf") continue;
    const key = face(asset);
    if (faces.has(key)) duplicates.add(key);
    faces.add(key);
  }
  const fonts = assets.filter(a => a.kind !== "ttf" || !duplicates.has(face(a)));
  const byName = new Map(fonts.map(a => [a.key, a]));
  const byDigest = new Map(fonts.map(a => [a.sha256, a]));
  const identity = sha(JSON.stringify([...manifest].sort(([a],[b]) => a.localeCompare(b,"en"))));
  return {
    identity,
    asset(digest: string) { return byDigest.get(digest); },
    select(name: string, bold?: boolean, italic?: boolean) {
      const target = name.trim().toLowerCase();
      const direct = byName.get(target);
      if (direct && (direct.kind === "shx" || bold === undefined && italic === undefined
          || direct.font.bold === Boolean(bold) && direct.font.italic === Boolean(italic))) return direct;
      if (safeName.test(target)) return;
      const match = fonts.filter(a => a.kind === "ttf" ? a.font.aliases.some(n => n.trim().toLowerCase() === target)
        && a.font.bold === Boolean(bold) && a.font.italic === Boolean(italic) : a.font.name.toLowerCase() === target);
      return match.length === 1 ? match[0] : undefined;
    },
    fontFiles(digests: Iterable<string>) {
      const paths: string[] = [];
      for (const digest of digests) {
        const a = byDigest.get(digest);
        if (!a || a.kind !== "ttf") continue;
        try {
          const current = lstatSync(a.path);
          if (current.isFile() && stamp(current) === a.stamp) { paths.push(a.path); continue; }
        } catch { /* The pinned file must be present. */ }
        throw new ReaderError("cad_font_assets_changed", "Файл закреплённого шрифта DWG изменился", 409);
      }
      return paths;
    },
  };
}

export type CadFontAssets = ReturnType<typeof readAssets>;
let loaded: { root?: string; fonts: CadFontAssets } | undefined;
export function dwgFontAssets() {
  const root = process.env.FACADE_DWG_FONT_DIR;
  if (!loaded || loaded.root !== root) loaded = { root, fonts: readAssets(root) };
  return loaded.fonts;
}
