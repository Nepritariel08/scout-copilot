import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type OwnedOdooContextSource,
  readOwnedOdooContextSource,
} from "../src/scout/owned-model/context-source";

const valid: OwnedOdooContextSource = {
  version: 1,
  sourceInstanceId: "odoo-community",
  baseUrl: "https://odoo.fixture.example",
  database: "fixture_community",
};

describe("protected Odoo context source configuration", () => {
  test("accepts only fixed, nonsecret connection identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scout-odoo-source-"));
    const path = join(directory, "source.json");
    try {
      await writeFile(path, JSON.stringify(valid), { mode: 0o600 });
      expect(await readOwnedOdooContextSource(path)).toEqual(valid);
    } finally {
      await rm(path, { force: true });
      await rmdir(directory);
    }
  });

  test("rejects credential material, request-controlled origins and malformed source names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scout-odoo-source-"));
    const path = join(directory, "source.json");
    try {
      const invalid = [
        { ...valid, apiKey: "synthetic-secret" },
        { ...valid, baseUrl: "http://odoo.fixture.example" },
        { ...valid, baseUrl: "https://user:secret@odoo.fixture.example" },
        { ...valid, baseUrl: "https://odoo.fixture.example/private" },
        { ...valid, baseUrl: "https://odoo.fixture.example/?redirect=1" },
        { ...valid, database: "bad/name" },
        { ...valid, sourceInstanceId: "invalid name" },
        { ...valid, version: 2 },
      ];
      for (const value of invalid) {
        await writeFile(path, JSON.stringify(value), { mode: 0o600 });
        await expect(readOwnedOdooContextSource(path)).rejects.toMatchObject({
          code: "MODEL_NOT_CONFIGURED",
        });
      }
    } finally {
      await rm(path, { force: true });
      await rmdir(directory);
    }
  });
});
