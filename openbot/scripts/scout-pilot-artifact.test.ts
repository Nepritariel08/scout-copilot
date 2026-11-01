import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  type PilotManifest,
  packagePilot,
  verifyPilot,
} from "./scout-pilot-artifact";

const bases: string[] = [];
const script = resolve(import.meta.dir, "scout-pilot-artifact.ts");
const digest = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
async function git(root: string, args: string[], input?: string) {
  const child = Bun.spawn(["git", "--no-pager", ...args], {
    cwd: root,
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined && child.stdin) {
    child.stdin.write(input);
    child.stdin.end();
  }
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) throw new Error(`Fixture git failed: ${stderr}`);
  return stdout.trim();
}
async function put(root: string, path: string, data: string) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
}
async function commit(root: string) {
  await git(root, ["add", "."]);
  await git(root, [
    "-c",
    "user.name=Synthetic Artifact Fixture",
    "-c",
    "user.email=artifact@fixture.invalid",
    "commit",
    "--quiet",
    "-m",
    "Synthetic artifact fixture",
  ]);
  return git(root, ["rev-parse", "HEAD"]);
}
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "scout-pilot-artifact-"));
  bases.push(base);
  const root = join(base, "repo"),
    project = join(root, "openbot"),
    output = join(base, "artifact");
  await mkdir(project, { recursive: true });
  await git(root, ["init", "--quiet"]);
  await git(root, ["config", "core.symlinks", "false"]);
  await put(
    root,
    ".gitignore",
    "openbot/app/dist/\nopenbot/app/src/lib/generated/\nignored-output/\n",
  );
  await put(root, ".gitattributes", "* text=auto eol=lf\n");
  await put(
    root,
    "LICENSE",
    "MIT License\nSynthetic fixture, not a production payload.\n",
  );
  await put(root, "openbot/bun.lock", "synthetic-frozen-lock\n");
  await put(
    root,
    "openbot/.env.example",
    "# Public credential-free example\nAPI_KEY=\n",
  );
  await put(
    root,
    "openbot/examples/scout/brand.yaml",
    "tenant:\n  id: scout\n  product_name: Scout\n",
  );
  await put(
    root,
    `docs/${"long".repeat(20)}/${"path".repeat(20)}/README.md`,
    "Synthetic long Git archive path\n",
  );
  await put(root, ".env.example", "openbot/.env.example");
  await git(root, ["add", "."]);
  const blob = await git(
    root,
    ["hash-object", "-w", "--stdin"],
    "openbot/.env.example",
  );
  await git(root, [
    "update-index",
    "--add",
    "--cacheinfo",
    `120000,${blob},.env.example`,
  ]);
  await git(root, [
    "-c",
    "user.name=Synthetic Artifact Fixture",
    "-c",
    "user.email=artifact@fixture.invalid",
    "commit",
    "--quiet",
    "-m",
    "Synthetic retained artifact",
  ]);
  const sha = await git(root, ["rev-parse", "HEAD"]);
  const config = join(project, "app/src/lib/generated/application-config.ts");
  await put(
    root,
    "openbot/app/src/lib/generated/application-config.ts",
    'export const appConfig: AppConfig = {"brand":{"tenantId":"scout","productName":"Scout"}};\n',
  );
  await utimes(config, 1, 1);
  await put(
    root,
    "openbot/app/dist/index.html",
    '<!doctype html><div id="root"></div><script type="module" src="/assets/main-fixture.js"></script>\n',
  );
  await put(
    root,
    "openbot/app/dist/assets/main-fixture.js",
    'const appConfig={brand:{tenantId:"scout",productName:"Scout"}};console.log(appConfig);\n',
  );
  await put(root, "owner.env", "SYNTHETIC_IGNORED_CREDENTIAL=never-package\n");
  return {
    base,
    root,
    project,
    output,
    sha,
    config,
    run: () =>
      packagePilot({ expectedSource: sha, output, projectDirectory: project }),
  };
}
async function manifest(output: string) {
  return JSON.parse(
    await readFile(join(output, "manifest.json"), "utf8"),
  ) as PilotManifest;
}
async function saveManifest(output: string, value: PilotManifest) {
  await writeFile(
    join(output, "manifest.json"),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

/** Tamper fixtures rewrite the checksums as an attacker could; they do not bypass the raw parser. */
async function editFirstHeader(
  output: string,
  name: "source.tar.gz" | "web.tar.gz",
  edit: (tar: Buffer, manifest: PilotManifest) => void,
) {
  const tar = gunzipSync(await readFile(join(output, name))),
    value = await manifest(output);
  edit(tar, value);
  tar.fill(32, 148, 156);
  const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  tar.write(checksum.toString(8).padStart(6, "0"), 148);
  tar[154] = 0;
  tar[155] = 32;
  const compressed = gzipSync(tar, { level: 9 });
  compressed.fill(0, 4, 8);
  compressed[9] = 3;
  value.archives[name].sha256 = digest(compressed);
  value.archives[name].bytes = compressed.length;
  await writeFile(join(output, name), compressed);
  await saveManifest(output, value);
}

afterEach(async () => {
  for (const base of bases.splice(0)) {
    const target = await realpath(base),
      temp = await realpath(tmpdir()),
      within = relative(temp, target);
    if (
      !within.startsWith("scout-pilot-artifact-") ||
      within.includes(sep) ||
      resolve(target) === resolve(temp)
    )
      throw new Error("Unsafe fixture cleanup target");
    await rm(target, { recursive: true, force: true });
  }
});

describe("retained Scout private pilot artifact", () => {
  test("packages actual Git archive including its safe source link, verifies commit/tree and inventories, excludes local files", async () => {
    const f = await fixture(),
      result = await f.run();
    expect(result.manifest.sourceSHA).toBe(f.sha);
    expect(result.manifest.sourceTreeSHA).toBe(
      await git(f.root, ["rev-parse", "HEAD^{tree}"]),
    );
    expect(result.manifest.brand).toEqual({
      tenantId: "scout",
      productName: "Scout",
    });
    expect(
      result.manifest.archives["source.tar.gz"].files.find(
        (file) => file.path === ".env.example",
      ),
    ).toMatchObject({ mode: 0o120000, link: "openbot/.env.example" });
    expect(
      result.manifest.archives["source.tar.gz"].files.some(
        (file) =>
          file.path === "owner.env" ||
          file.path.includes("node_modules") ||
          file.path.includes("app/dist"),
      ),
    ).toBe(false);
    expect(
      (await verifyPilot({ directory: f.output, expectedSource: f.sha }))
        .manifestSHA256,
    ).toBe(result.manifestSHA256);
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        script,
        "verify",
        "--directory",
        f.output,
        "--expected-source",
        f.sha,
      ],
      { cwd: f.base, stdout: "pipe", stderr: "pipe" },
    );
    const text = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(text).manifestSHA256).toBe(result.manifestSHA256);
  });

  test("two packages of the same immutable source and prebuilt web have identical bytes", async () => {
    const f = await fixture();
    await f.run();
    const second = join(f.base, "second");
    await packagePilot({
      expectedSource: f.sha,
      projectDirectory: f.project,
      output: second,
    });
    for (const name of ["source.tar.gz", "web.tar.gz", "manifest.json"])
      expect(
        (await readFile(join(f.output, name))).equals(
          await readFile(join(second, name)),
        ),
      ).toBe(true);
  });

  test("refuses wrong source, dirty tracked files, existing output and unignored output inside source", async () => {
    const f = await fixture();
    await expect(
      packagePilot({
        expectedSource: "0".repeat(40),
        projectDirectory: f.project,
        output: f.output,
      }),
    ).rejects.toThrow("HEAD");
    await put(f.root, "LICENSE", "changed tracked source");
    await expect(f.run()).rejects.toThrow("dirty");
    await git(f.root, ["restore", "LICENSE"]);
    await expect(
      packagePilot({
        expectedSource: f.sha,
        projectDirectory: f.project,
        output: join(f.root, "not-ignored"),
      }),
    ).rejects.toThrow();
    await mkdir(f.output);
    await put(f.output, "keep.txt", "leave existing data alone");
    await expect(f.run()).rejects.toThrow("already exists");
    expect(await readFile(join(f.output, "keep.txt"), "utf8")).toBe(
      "leave existing data alone",
    );
  });

  test("refuses default-brand generated config, stale build, wrong bundle brand and dangling index references", async () => {
    const f = await fixture(),
      js = join(f.project, "app/dist/assets/main-fixture.js");
    const generated = await readFile(f.config, "utf8");
    await writeFile(f.config, generated.replace('"Scout"', '"OpenDuet"'));
    await expect(f.run()).rejects.toThrow("not Scout");
    await writeFile(f.config, generated);
    await utimes(f.config, 1, 1);
    await utimes(js, 0, 0);
    await expect(f.run()).rejects.toThrow("stale");
    await writeFile(
      js,
      'const config={brand:{tenantId:"openduet",productName:"OpenDuet"}};',
    );
    await expect(f.run()).rejects.toThrow("Scout application config");
    await rm(js);
    await expect(f.run()).rejects.toThrow("missing asset");
  });

  test("rejects tracked credential filenames and unexpected built files", async () => {
    const f = await fixture();
    await put(f.root, ".env", "SYNTHETIC_ONLY=do-not-package");
    const sha = await commit(f.root);
    await expect(
      packagePilot({
        expectedSource: sha,
        projectDirectory: f.project,
        output: f.output,
      }),
    ).rejects.toThrow("credential");
    const g = await fixture();
    await put(g.root, "openbot/app/dist/.env", "SYNTHETIC_ONLY=do-not-package");
    await expect(g.run()).rejects.toThrow("Unexpected web");
  });

  test("production WebSocket setting reads pass while injected development HTML refuses", async () => {
    const f = await fixture(),
      js = join(f.project, "app/dist/assets/main-fixture.js");
    await writeFile(
      js,
      `${await readFile(js, "utf8")}const optionalPort=window.__OPENBOT_WS_PORT__;`,
    );
    await f.run();
    const g = await fixture(),
      index = join(g.project, "app/dist/index.html");
    await writeFile(
      index,
      `${await readFile(index, "utf8")}<script>window.__OPENBOT_WS_PORT__="3001";</script>`,
    );
    await expect(g.run()).rejects.toThrow("Development server");
  });

  test("Scout identity must be index-reachable and transitive module/CSS dependencies must exist", async () => {
    const f = await fixture();
    const main = join(f.project, "app/dist/assets/main-fixture.js"),
      original = await readFile(main, "utf8");
    await put(f.root, "openbot/app/dist/assets/decoy.js", original);
    await writeFile(
      main,
      'const config={brand:{tenantId:"openduet",productName:"OpenDuet"}};',
    );
    await expect(f.run()).rejects.toThrow("reachable Scout");
    await writeFile(main, `import "./missing-chunk.js";${original}`);
    await expect(f.run()).rejects.toThrow("Missing transitive");
    await writeFile(main, 'import "./decoy.js";');
    await f.run();
    const g = await fixture();
    await put(
      g.root,
      "openbot/app/dist/assets/main-fixture.css",
      'body{font-family:Fixture;src:url("./missing-font.woff2")}',
    );
    const index = join(g.project, "app/dist/index.html");
    await writeFile(
      index,
      `${await readFile(index, "utf8")}<link rel="stylesheet" href="/assets/main-fixture.css">`,
    );
    await expect(g.run()).rejects.toThrow("Missing transitive");
  });

  test("rejects web hardlinks and extra output files", async () => {
    const f = await fixture();
    await link(
      join(f.project, "app/dist/assets/main-fixture.js"),
      join(f.base, "linked.js"),
    );
    await expect(f.run()).rejects.toThrow("Nonregular");
    const g = await fixture();
    await g.run();
    await put(g.output, "unexpected.txt", "not in artifact");
    await expect(
      verifyPilot({ directory: g.output, expectedSource: g.sha }),
    ).rejects.toThrow("contents");
  });

  test.skipIf(process.platform === "win32")(
    "rejects linked web entries and linked output directory",
    async () => {
      const f = await fixture();
      await symlink(
        join(f.base, "not-a-file"),
        join(f.project, "app/dist/assets/link.js"),
      );
      await expect(f.run()).rejects.toThrow("symlink");
      const g = await fixture();
      await g.run();
      const alias = join(g.base, "alias");
      await symlink(g.output, alias);
      await expect(
        verifyPilot({ directory: alias, expectedSource: g.sha }),
      ).rejects.toThrow("Linked");
    },
  );

  test("refuses changed archive bytes and manifest/source mismatches", async () => {
    const f = await fixture();
    await f.run();
    await expect(
      verifyPilot({ directory: f.output, expectedSource: "1".repeat(40) }),
    ).rejects.toThrow("manifest identity");
    const value = await manifest(f.output);
    value.sourceTreeSHA = "0".repeat(40);
    await saveManifest(f.output, value);
    await expect(
      verifyPilot({ directory: f.output, expectedSource: f.sha }),
    ).rejects.toThrow("commit/tree");
    const g = await fixture();
    await g.run();
    const bytes = await readFile(join(g.output, "web.tar.gz"));
    bytes[20] ^= 1;
    await writeFile(join(g.output, "web.tar.gz"), bytes);
    await expect(
      verifyPilot({ directory: g.output, expectedSource: g.sha }),
    ).rejects.toThrow();
  });

  test("raw traversal, hardlinks, secret paths and duplicate members refuse even with rewritten manifest hashes", async () => {
    const f = await fixture();
    await f.run();
    const originalArchive = await readFile(join(f.output, "web.tar.gz"));
    const originalManifest = await readFile(join(f.output, "manifest.json"));
    for (const attack of [
      "traversal",
      "hardlink",
      "secret",
      "duplicate",
    ] as const) {
      await writeFile(join(f.output, "web.tar.gz"), originalArchive);
      await writeFile(join(f.output, "manifest.json"), originalManifest);
      await editFirstHeader(f.output, "web.tar.gz", (tar, value) => {
        if (attack === "hardlink") tar[156] = "1".charCodeAt(0);
        else {
          const path =
            attack === "traversal"
              ? "../escape.js"
              : attack === "duplicate"
                ? "index.html"
                : ".env";
          tar.fill(0, 0, 100);
          tar.write(path, 0);
          value.archives["web.tar.gz"].files[0].path = path;
        }
      });
      await expect(
        verifyPilot({ directory: f.output, expectedSource: f.sha }),
      ).rejects.toThrow();
    }
  });

  test("CLI rejects unpinned arguments instead of building or activating anything", async () => {
    const f = await fixture();
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        script,
        "package",
        "--expected-source",
        f.sha,
        "--output",
        f.output,
        "--force",
      ],
      { cwd: f.project, stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("Usage");
  });
});
