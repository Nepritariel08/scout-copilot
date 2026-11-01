#!/usr/bin/env bun
/** Retained source + prebuilt web bytes only. Never installs, executes or extracts the payload. */
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const BUN_VERSION = "1.4.3";
const BRAND = { tenantId: "scout", productName: "Scout" } as const;
const LIMIT = 512 * 1024 * 1024;
const OUTPUT_FILES = ["manifest.json", "source.tar.gz", "web.tar.gz"];
type Entry = { path: string; mode: number; data: Buffer; link?: string };
type FileInventory = {
  path: string;
  mode: number;
  bytes: number;
  sha256: string;
  link?: string;
};
type Archive = { bytes: number; sha256: string; files: FileInventory[] };
export type PilotManifest = {
  version: 1;
  sourceSHA: string;
  sourceTreeSHA: string;
  sourceCommit: string;
  bunVersion: "1.4.3";
  platform: "linux-x64";
  brand: typeof BRAND;
  lockfile: { path: "openbot/bun.lock"; bytes: number; sha256: string };
  generatedAppConfig: {
    path: "openbot/app/src/lib/generated/application-config.ts";
    bytes: number;
    sha256: string;
  };
  archives: { "source.tar.gz": Archive; "web.tar.gz": Archive };
};

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const hash = (data: Uint8Array, algorithm = "sha256") =>
  createHash(algorithm).update(data).digest("hex");
const order = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const objectHash = (type: string, data: Buffer) =>
  hash(Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data]), "sha1");

function safePath(path: string) {
  check(
    path.length > 0 &&
      path.length <= 1024 &&
      !/[\\:]/.test(path) &&
      !Array.from(path).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
    "Unsafe archive path",
  );
  check(
    !path.startsWith("/") &&
      path.split("/").every((part) => part && part !== "." && part !== ".."),
    "Unsafe archive path",
  );
  check(
    !path.split("/").some((part) => [".git", "node_modules"].includes(part)),
    "Forbidden payload directory",
  );
}
function safeSource(entry: Entry) {
  safePath(entry.path);
  const name = entry.path.split("/").at(-1) ?? "";
  check(
    !(
      name.endsWith(".env") ||
      (name.startsWith(".env") && name !== ".env.example")
    ) && !/\.(?:pem|key|p12|pfx|crt)$/i.test(name),
    "Private credential filename in source",
  );
  if (entry.link !== undefined)
    check(
      entry.path === ".env.example" &&
        entry.link === "openbot/.env.example" &&
        entry.mode === 0o120000,
      "Unsupported source link",
    );
  else
    check(
      entry.mode === 0o100644 || entry.mode === 0o100755,
      "Unsupported source mode",
    );
}
function canonicalGzip(tar: Buffer) {
  const data = gzipSync(tar, { level: 9 });
  data.fill(0, 4, 8);
  data[9] = 3; // Stable target OS; no timestamp, filename or host information.
  return data;
}
function cstring(data: Buffer) {
  const zero = data.indexOf(0);
  const value = data.subarray(0, zero < 0 ? data.length : zero);
  const decoded = value.toString("utf8");
  check(Buffer.from(decoded).equals(value), "Invalid UTF-8 archive name");
  return decoded;
}
function number(data: Buffer) {
  const value = cstring(data).trim();
  check(/^[0-7]*$/.test(value), "Invalid tar number");
  const result = Number.parseInt(value || "0", 8);
  check(Number.isSafeInteger(result) && result >= 0, "Invalid tar size");
  return result;
}
function pax(data: Buffer) {
  const fields = new Map<string, string>();
  for (let offset = 0; offset < data.length; ) {
    const space = data.indexOf(32, offset);
    check(space > offset, "Invalid PAX record");
    const length = Number(data.subarray(offset, space).toString("ascii"));
    check(
      Number.isSafeInteger(length) &&
        length > space - offset + 2 &&
        offset + length <= data.length &&
        data[offset + length - 1] === 10,
      "Invalid PAX length",
    );
    const text = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = text.indexOf("=");
    check(
      equals > 0 && !fields.has(text.slice(0, equals)),
      "Duplicate PAX field",
    );
    fields.set(text.slice(0, equals), text.slice(equals + 1));
    offset += length;
  }
  return fields;
}

/** Parse before any extraction; only regular files and the exact upstream source link survive. */
function readTar(data: Buffer, source: boolean): Entry[] {
  check(data.length <= LIMIT && data.length % 512 === 0, "Invalid tar length");
  const entries: Entry[] = [];
  const seen = new Set<string>();
  let nextPath: string | undefined;
  for (let offset = 0; offset + 512 <= data.length; ) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      check(
        nextPath === undefined &&
          data.subarray(offset).every((byte) => byte === 0) &&
          data.length - offset >= 1024,
        "Invalid tar terminator",
      );
      return entries;
    }
    let checksum = 0;
    for (let i = 0; i < 512; i++)
      checksum += i >= 148 && i < 156 ? 32 : header[i];
    check(
      checksum === number(header.subarray(148, 156)),
      "Tar checksum mismatch",
    );
    const size = number(header.subarray(124, 136));
    const start = offset + 512;
    check(
      size <= LIMIT && start + Math.ceil(size / 512) * 512 <= data.length,
      "Truncated tar entry",
    );
    const content = data.subarray(start, start + size);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = cstring(header.subarray(345, 500));
    let path = [prefix, cstring(header.subarray(0, 100))]
      .filter(Boolean)
      .join("/");
    offset = start + Math.ceil(size / 512) * 512;
    if (type === "x" || type === "g") {
      check(source, "Web metadata entries are not permitted");
      const fields = pax(content);
      if (type === "g")
        check(
          fields.size === 1 &&
            /^[a-f0-9]{40}$/.test(fields.get("comment") ?? ""),
          "Unsupported global tar metadata",
        );
      else {
        check(
          nextPath === undefined && fields.size === 1 && fields.has("path"),
          "Unsupported PAX metadata",
        );
        nextPath = fields.get("path");
      }
      continue;
    }
    path = nextPath ?? path;
    nextPath = undefined;
    if (type === "5") {
      check(source && size === 0, "Unexpected directory entry");
      safePath(path.replace(/\/$/, ""));
      continue;
    }
    safePath(path);
    check(
      !seen.has(path) && entries.length < 100000,
      "Duplicate archive entry",
    );
    seen.add(path);
    const mode = number(header.subarray(100, 108));
    if (type === "2") {
      check(source && size === 0, "Forbidden archive link");
      const link = cstring(header.subarray(157, 257));
      const entry = { path, mode: 0o120000, data: Buffer.from(link), link };
      safeSource(entry);
      entries.push(entry);
    } else {
      check(type === "0", "Nonregular archive entry");
      entries.push({
        path,
        mode: mode & 0o111 ? 0o100755 : 0o100644,
        data: Buffer.from(content),
      });
    }
  }
  throw new Error("Missing tar terminator");
}

function headerFor(
  path: string,
  bytes: number,
  mode: number,
  type = "0",
  link = "",
) {
  let name = path,
    prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const cut = [...path.matchAll(/\//g)]
      .map((match) => match.index)
      .find(
        (index) =>
          Buffer.byteLength(path.slice(0, index)) <= 155 &&
          Buffer.byteLength(path.slice(index + 1)) <= 100,
      );
    check(cut !== undefined, "Archive path exceeds canonical USTAR limits");
    name = path.slice(cut + 1);
    prefix = path.slice(0, cut);
  }
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write(prefix, 345);
  const octal = (value: number, start: number, width: number) => {
    const text = value.toString(8).padStart(width - 1, "0");
    check(text.length < width, "Tar numeric overflow");
    header.write(text, start);
    header[start + width - 1] = 0;
  };
  octal(mode & 0o777, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(bytes, 124, 12);
  octal(0, 136, 12);
  header.fill(32, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write(link, 157);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148);
  header[154] = 0;
  header[155] = 32;
  return header;
}
function tarFor(entries: Entry[]) {
  const pieces: Buffer[] = [];
  for (const entry of [...entries].sort((a, b) => order(a.path, b.path))) {
    safePath(entry.path);
    pieces.push(
      headerFor(
        entry.path,
        entry.link === undefined ? entry.data.length : 0,
        entry.mode,
        entry.link === undefined ? "0" : "2",
        entry.link,
      ),
    );
    if (entry.link === undefined) {
      pieces.push(entry.data);
      const padding = (512 - (entry.data.length % 512)) % 512;
      if (padding) pieces.push(Buffer.alloc(padding));
    }
  }
  pieces.push(Buffer.alloc(1024));
  return Buffer.concat(pieces);
}
function treeFor(entries: Entry[]) {
  type Tree = Map<string, Tree | Entry>;
  const root: Tree = new Map();
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let tree = root;
    for (const name of parts.slice(0, -1)) {
      const child = tree.get(name);
      check(
        child === undefined || child instanceof Map,
        "File/directory collision",
      );
      if (child instanceof Map) tree = child;
      else {
        const created: Tree = new Map();
        tree.set(name, created);
        tree = created;
      }
    }
    const name = parts.at(-1) as string;
    check(!tree.has(name), "Duplicate Git tree path");
    tree.set(name, entry);
  }
  const digest = (tree: Tree): string => {
    const children = [...tree].sort(([an, av], [bn, bv]) =>
      order(
        `${an}${av instanceof Map ? "/" : ""}`,
        `${bn}${bv instanceof Map ? "/" : ""}`,
      ),
    );
    return objectHash(
      "tree",
      Buffer.concat(
        children.map(([name, value]) =>
          Buffer.concat([
            Buffer.from(
              `${value instanceof Map ? "40000" : value.mode.toString(8)} ${name}\0`,
            ),
            Buffer.from(
              value instanceof Map
                ? digest(value)
                : objectHash("blob", value.data),
              "hex",
            ),
          ]),
        ),
      ),
    );
  };
  return digest(root);
}
function inventory(entries: Entry[]): FileInventory[] {
  return [...entries]
    .sort((a, b) => order(a.path, b.path))
    .map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      bytes: entry.data.length,
      sha256: hash(entry.data),
      ...(entry.link === undefined ? {} : { link: entry.link }),
    }));
}
function describeArchive(data: Buffer, entries: Entry[]): Archive {
  return { bytes: data.length, sha256: hash(data), files: inventory(entries) };
}

async function command(cwd: string, args: string[]) {
  const proc = Bun.spawn(
    ["git", "--no-optional-locks", "--no-pager", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  const [out, _error, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  check(
    code === 0 && out.byteLength <= LIMIT,
    `Git prerequisite failed (${args[0]})`,
  );
  return Buffer.from(out);
}
async function plainFile(path: string, maxBytes = LIMIT) {
  const stat = await lstat(path);
  check(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      stat.size <= maxBytes,
    "Expected bounded regular file",
  );
  return { data: await readFile(path), stat };
}
function generatedConfig(data: Buffer) {
  const text = data.toString("utf8");
  const prefix = "export const appConfig: AppConfig = ";
  const start = text.indexOf(prefix);
  check(
    start >= 0 && text.trimEnd().endsWith(";"),
    "Missing generated application config",
  );
  const parsed: unknown = JSON.parse(
    text
      .slice(start + prefix.length)
      .trim()
      .slice(0, -1),
  );
  check(
    JSON.stringify(parsed) === JSON.stringify({ brand: BRAND }),
    "Generated application config is not Scout",
  );
}
function webCheck(entries: Entry[]) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    safePath(entry.path);
    check(
      entry.link === undefined &&
        entry.mode === 0o100644 &&
        (entry.path === "index.html" ||
          /^assets\/[^/]+\.(?:js|css|woff2?|ttf|otf|png|svg|webp|jpe?g|gif|avif|ico|wasm)$/.test(
            entry.path,
          )),
      "Unexpected web payload file",
    );
    if (/\.(?:html|js|css)$/.test(entry.path))
      check(
        !/@vite\/client|react-refresh|(?:localhost|127\.0\.0\.1):(?:3010|5173)\b/.test(
          entry.data.toString("utf8"),
        ),
        "Development server reference in web payload",
      );
  }
  const index = byPath.get("index.html")?.data.toString("utf8");
  check(
    index && /<div\s+id=["']root["']/.test(index),
    "Missing production index",
  );
  const references = [...index.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  check(
    !/__OPENBOT_WS_PORT__\s*=|\/src\/|(?:src|href)=["'](?:https?:\/\/|\/\/)/.test(
      index,
    ),
    "Development server reference in index",
  );
  check(
    references.some((reference) => /^\/assets\/.+\.js$/.test(reference)),
    "Missing production module asset",
  );
  for (const reference of references) {
    check(
      reference.startsWith("/assets/") && !/[?#%]/.test(reference),
      "Unexpected index asset reference",
    );
    check(byPath.has(reference.slice(1)), "Index references missing asset");
  }
  const reachable = new Set<string>();
  const resolveAsset = (reference: string, from: string) => {
    check(!/[?%]/.test(reference), "Ambiguous built asset reference");
    const path = reference.startsWith("/assets/")
      ? reference.slice(1)
      : reference.startsWith("assets/")
        ? reference
        : posix.normalize(posix.join(posix.dirname(from), reference));
    safePath(path);
    check(
      path.startsWith("assets/") && byPath.has(path),
      "Missing transitive built asset",
    );
    return path;
  };
  const visit = (path: string) => {
    if (reachable.has(path)) return;
    reachable.add(path);
    const entry = byPath.get(path);
    check(entry, "Missing reachable web file");
    const text = entry.data.toString("utf8");
    if (path.endsWith(".js")) {
      for (const dependency of new Bun.Transpiler({ loader: "js" }).scanImports(
        text,
      )) {
        check(
          dependency.path.startsWith("."),
          "External built module dependency",
        );
        visit(resolveAsset(dependency.path, path));
      }
      // Vite's preload dependency table uses root-relative asset strings outside import syntax.
      for (const match of text.matchAll(
        /["'](assets\/[^"']+\.(?:js|css|woff2?|png|svg|webp))["']/g,
      ))
        resolveAsset(match[1], path);
    }
    if (path.endsWith(".css")) {
      for (const match of text.matchAll(
        /url\(\s*["']?([^\s"')]+)["']?\s*\)/g,
      )) {
        if (match[1].startsWith("data:") || match[1].startsWith("#")) continue;
        visit(resolveAsset(match[1].split("#")[0], path));
      }
    }
  };
  for (const reference of references) visit(reference.slice(1));
  check(
    [...reachable].some(
      (path) =>
        path.endsWith(".js") &&
        /["']?tenantId["']?\s*:\s*["']scout["']\s*,\s*["']?productName["']?\s*:\s*["']Scout["']/.test(
          byPath.get(path)?.data.toString("utf8") ?? "",
        ),
    ),
    "Built assets do not contain reachable Scout application config",
  );
}
async function webFiles(directory: string, after: number): Promise<Entry[]> {
  const root = await lstat(directory);
  check(
    root.isDirectory() && !root.isSymbolicLink(),
    "Missing prebuilt app/dist",
  );
  const entries: Entry[] = [];
  async function walk(path: string, prefix: string) {
    for (const name of (await readdir(path)).sort(order)) {
      const absolute = join(path, name),
        entryPath = `${prefix}${name}`,
        stat = await lstat(absolute);
      check(!stat.isSymbolicLink(), "Web symlink is forbidden");
      if (stat.isDirectory()) {
        check(entryPath === "assets", "Unexpected web directory");
        await walk(absolute, `${entryPath}/`);
      } else {
        check(
          stat.isFile() &&
            stat.nlink === 1 &&
            stat.size <= LIMIT &&
            stat.mtimeMs >= after,
          "Nonregular or stale prebuilt web file",
        );
        entries.push({
          path: entryPath,
          mode: 0o100644,
          data: await readFile(absolute),
        });
      }
    }
  }
  await walk(directory, "");
  webCheck(entries);
  return entries;
}
async function noSymlinkAncestors(path: string) {
  for (let current = path; ; current = dirname(current)) {
    const stat = await lstat(current);
    check(
      stat.isDirectory() && !stat.isSymbolicLink(),
      "Linked or non-directory output parent",
    );
    if (dirname(current) === current) return;
  }
}
function expectedSHA(value: string) {
  check(
    /^[a-f0-9]{40}$/.test(value),
    "Expected source must be 40 lowercase hex characters",
  );
}

export async function packagePilot(options: {
  expectedSource: string;
  output: string;
  projectDirectory?: string;
}) {
  expectedSHA(options.expectedSource);
  check(Bun.version === BUN_VERSION, "Bun 1.4.3 is required");
  const project = await realpath(
    resolve(options.projectDirectory ?? process.cwd()),
  );
  const root = await realpath(
    (await command(project, ["rev-parse", "--show-toplevel"]))
      .toString()
      .trim(),
  );
  check(
    relative(resolve(root, "openbot"), project) === "",
    "Run packaging from openbot/",
  );
  check(
    (await command(root, ["rev-parse", "HEAD"])).toString().trim() ===
      options.expectedSource,
    "HEAD does not match expected source",
  );
  check(
    (await command(root, ["status", "--porcelain=v1", "--untracked-files=no"]))
      .length === 0,
    "Tracked source is dirty",
  );
  check(
    isAbsolute(options.output) && resolve(options.output) === options.output,
    "Output must be an absolute canonical path",
  );
  await noSymlinkAncestors(dirname(options.output));
  const physicalOutput = join(
    await realpath(dirname(options.output)),
    relative(dirname(options.output), options.output),
  );
  const inside = relative(await realpath(root), physicalOutput);
  if (
    !inside.startsWith(`..${sep}`) &&
    inside !== ".." &&
    !isAbsolute(inside)
  ) {
    check(
      inside &&
        (await command(root, ["check-ignore", "--no-index", "--", inside]))
          .toString()
          .trim(),
      "Output inside source must be Git-ignored",
    );
  }
  check(
    !(await lstat(options.output).catch((error: NodeJS.ErrnoException) => {
      check(error.code === "ENOENT", "Cannot inspect output");
      return null;
    })),
    "Output already exists; refusing overwrite",
  );
  const commit = await command(root, [
    "cat-file",
    "commit",
    options.expectedSource,
  ]);
  const source = readTar(
    await command(root, ["archive", "--format=tar", options.expectedSource]),
    true,
  );
  for (const entry of source) safeSource(entry);
  const tree = treeFor(source);
  check(
    objectHash("commit", commit) === options.expectedSource &&
      commit.toString().startsWith(`tree ${tree}\n`),
    "Archive differs from exact Git tree",
  );
  const lock = source.find((entry) => entry.path === "openbot/bun.lock");
  check(
    lock &&
      source.some(
        (entry) => entry.path === "LICENSE" && entry.data.includes("MIT"),
      ),
    "Missing lockfile or MIT license",
  );
  const sourceBrand = source
    .find((entry) => entry.path === "openbot/examples/scout/brand.yaml")
    ?.data.toString();
  check(
    sourceBrand &&
      /^\s+id: scout\s*$/m.test(sourceBrand) &&
      /^\s+product_name: Scout\s*$/m.test(sourceBrand),
    "Source Scout identity is missing",
  );
  const generated = await plainFile(
    join(project, "app/src/lib/generated/application-config.ts"),
    65536,
  );
  generatedConfig(generated.data);
  const web = await webFiles(join(project, "app/dist"), generated.stat.mtimeMs);
  const sourceData = canonicalGzip(tarFor(source)),
    webData = canonicalGzip(tarFor(web));
  const manifest: PilotManifest = {
    version: 1,
    sourceSHA: options.expectedSource,
    sourceTreeSHA: tree,
    sourceCommit: commit.toString("base64"),
    bunVersion: BUN_VERSION,
    platform: "linux-x64",
    brand: BRAND,
    lockfile: {
      path: "openbot/bun.lock",
      bytes: lock.data.length,
      sha256: hash(lock.data),
    },
    generatedAppConfig: {
      path: "openbot/app/src/lib/generated/application-config.ts",
      bytes: generated.data.length,
      sha256: hash(generated.data),
    },
    archives: {
      "source.tar.gz": describeArchive(sourceData, source),
      "web.tar.gz": describeArchive(webData, web),
    },
  };
  // Refuse a source/HEAD change during collection, before creating the new output directory.
  check(
    (await command(root, ["rev-parse", "HEAD"])).toString().trim() ===
      options.expectedSource &&
      (
        await command(root, [
          "status",
          "--porcelain=v1",
          "--untracked-files=no",
        ])
      ).length === 0,
    "Source changed during packaging",
  );
  await mkdir(options.output, { mode: 0o700 });
  await writeFile(join(options.output, "source.tar.gz"), sourceData, {
    flag: "wx",
  });
  await writeFile(join(options.output, "web.tar.gz"), webData, { flag: "wx" });
  await writeFile(join(options.output, "manifest.json"), json(manifest), {
    flag: "wx",
  });
  return verifyPilot({
    directory: options.output,
    expectedSource: options.expectedSource,
  });
}

export async function verifyPilot(options: {
  directory: string;
  expectedSource: string;
}) {
  expectedSHA(options.expectedSource);
  check(Bun.version === BUN_VERSION, "Bun 1.4.3 is required");
  check(isAbsolute(options.directory), "Artifact directory must be absolute");
  await noSymlinkAncestors(options.directory);
  check(
    JSON.stringify((await readdir(options.directory)).sort()) ===
      JSON.stringify(OUTPUT_FILES),
    "Unexpected artifact directory contents",
  );
  const rawManifest = (
    await plainFile(join(options.directory, "manifest.json"), 16 * 1024 * 1024)
  ).data;
  const manifest = JSON.parse(rawManifest.toString("utf8")) as PilotManifest;
  check(
    rawManifest.toString() === json(manifest) &&
      manifest.version === 1 &&
      manifest.sourceSHA === options.expectedSource &&
      manifest.bunVersion === BUN_VERSION &&
      manifest.platform === "linux-x64" &&
      JSON.stringify(manifest.brand) === JSON.stringify(BRAND),
    "Invalid manifest identity",
  );
  const parsed: Record<string, Entry[]> = {};
  for (const name of ["source.tar.gz", "web.tar.gz"] as const) {
    const compressed = (await plainFile(join(options.directory, name))).data;
    const tar = gunzipSync(compressed, { maxOutputLength: LIMIT });
    const entries = readTar(tar, name === "source.tar.gz");
    check(
      tar.equals(tarFor(entries)) && compressed.equals(canonicalGzip(tar)),
      "Archive is not canonical",
    );
    check(
      JSON.stringify(describeArchive(compressed, entries)) ===
        JSON.stringify(manifest.archives?.[name]),
      "Archive hash, size or inventory mismatch",
    );
    parsed[name] = entries;
  }
  const source = parsed["source.tar.gz"],
    web = parsed["web.tar.gz"];
  for (const entry of source) safeSource(entry);
  const commit = Buffer.from(manifest.sourceCommit, "base64"),
    tree = treeFor(source);
  check(
    commit.length <= 1024 * 1024 &&
      objectHash("commit", commit) === options.expectedSource &&
      manifest.sourceTreeSHA === tree &&
      commit.toString().startsWith(`tree ${tree}\n`),
    "Source commit/tree proof mismatch",
  );
  const lock = source.find((entry) => entry.path === "openbot/bun.lock");
  check(
    lock &&
      JSON.stringify(manifest.lockfile) ===
        JSON.stringify({
          path: "openbot/bun.lock",
          bytes: lock.data.length,
          sha256: hash(lock.data),
        }) &&
      source.some(
        (entry) => entry.path === "LICENSE" && entry.data.includes("MIT"),
      ),
    "Lockfile/license mismatch",
  );
  check(
    manifest.generatedAppConfig?.path ===
      "openbot/app/src/lib/generated/application-config.ts" &&
      /^[a-f0-9]{64}$/.test(manifest.generatedAppConfig.sha256) &&
      Number.isSafeInteger(manifest.generatedAppConfig.bytes),
    "Generated config receipt missing",
  );
  webCheck(web);
  check(
    Object.keys(manifest).sort().join() ===
      [
        "archives",
        "brand",
        "bunVersion",
        "generatedAppConfig",
        "lockfile",
        "platform",
        "sourceCommit",
        "sourceSHA",
        "sourceTreeSHA",
        "version",
      ]
        .sort()
        .join() &&
      Object.keys(manifest.archives).sort().join() ===
        "source.tar.gz,web.tar.gz",
    "Unexpected manifest fields",
  );
  return { manifest, manifestSHA256: hash(rawManifest) };
}

if (import.meta.main) {
  try {
    const [action, ...args] = process.argv.slice(2);
    check(
      args.length === 4 &&
        args[0] ===
          (action === "package" ? "--expected-source" : "--directory") &&
        args[2] === (action === "package" ? "--output" : "--expected-source") &&
        ["package", "verify"].includes(action),
      "Usage: package --expected-source <40hex> --output <absoluteOUT> | verify --directory <absoluteOUT> --expected-source <40hex>",
    );
    if (action === "package")
      check(
        process.platform === "linux" && process.arch === "x64",
        "Production packaging must run on linux-x64; verification is platform-independent.",
      );
    const result =
      action === "package"
        ? await packagePilot({ expectedSource: args[1], output: args[3] })
        : await verifyPilot({ directory: args[1], expectedSource: args[3] });
    console.log(
      JSON.stringify({
        verified: true,
        sourceSHA: result.manifest.sourceSHA,
        manifestSHA256: result.manifestSHA256,
        files: OUTPUT_FILES,
      }),
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Artifact verification failed",
    );
    process.exitCode = 1;
  }
}
