import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createScoutBindingReader,
  parseScoutBinding,
} from "../src/scout/binding";

export function scoutFixtureConfig() {
  return {
    version: 1,
    deploymentId: "scout-test",
    policies: [
      {
        tenantId: "tenant-a",
        revision: 1,
        active: true,
        draftAnalysis: true,
        expiresAt: "2099-01-01T00:00:00Z",
      },
    ],
    bindings: [
      {
        userId: "scout-fixture-alice",
        tenantId: "tenant-a",
        policyRevision: 1,
        active: true,
        expiresAt: "2099-01-01T00:00:00Z",
        command: [join(tmpdir(), "python.exe"), "-m", "scout_queue.mcp_server"],
        cwd: tmpdir(),
        environment: {
          SCOUT_ODOO_URL: "http://127.0.0.1:9999",
          SCOUT_ODOO_DB: "synthetic_odoo",
          SCOUT_ODOO_UID: "11",
          SCOUT_ODOO_COMPANY_IDS: "1,2",
          SCOUT_ODOO_KEY_FILE: join(tmpdir(), "synthetic-unused.key"),
        },
      },
    ],
  };
}
const actor = { id: "scout-fixture-alice" };

describe("explicit native account to tenant/requester binding", () => {
  test("binds the native id, not an email or caller-provided Odoo uid", () => {
    const binding = parseScoutBinding(scoutFixtureConfig(), actor);
    expect(binding.identity).toEqual({
      database: "synthetic_odoo",
      uid: 11,
      companyIds: [1, 2],
    });
    expect(binding.fingerprint).toHaveLength(64);
    expect(() =>
      parseScoutBinding(scoutFixtureConfig(), { id: "alice@example.com" }),
    ).toThrow("SCOUT_ACCESS_DENIED");
  });
  for (const change of [
    "membership",
    "policy",
    "expiry",
    "policy-expiry",
    "version",
    "missing-policy",
    "permission",
  ] as const) {
    test(`${change} revocation denies admission`, () => {
      const config = scoutFixtureConfig();
      if (change === "membership") config.bindings[0].active = false;
      if (change === "policy") config.policies[0].active = false;
      if (change === "expiry")
        config.bindings[0].expiresAt = "2000-01-01T00:00:00Z";
      if (change === "policy-expiry")
        config.policies[0].expiresAt = "2000-01-01T00:00:00Z";
      if (change === "version") config.bindings[0].policyRevision = 2;
      if (change === "missing-policy") config.policies = [];
      if (change === "permission") config.policies[0].draftAnalysis = false;
      expect(() => parseScoutBinding(config, actor)).toThrow(
        "SCOUT_ACCESS_DENIED",
      );
    });
  }
  for (const change of [
    "duplicate-user",
    "shared-requester",
    "duplicate-policy",
    "extra-env",
    "command",
    "insecure-origin",
    "origin-credentials",
    "duplicate-company",
    "unsafe-uid",
  ] as const) {
    test(`${change} is refused before any connector runs`, () => {
      const config = scoutFixtureConfig();
      if (change === "duplicate-user")
        config.bindings.push(structuredClone(config.bindings[0]));
      if (change === "shared-requester")
        config.bindings.push({
          ...structuredClone(config.bindings[0]),
          userId: "bob",
        });
      if (change === "duplicate-policy")
        config.policies.push(structuredClone(config.policies[0]));
      if (change === "extra-env")
        Object.assign(config.bindings[0].environment, {
          OPENAI_API_KEY: "synthetic-forbidden",
        });
      if (change === "command") config.bindings[0].command[1] = "-c";
      if (change === "insecure-origin")
        config.bindings[0].environment.SCOUT_ODOO_URL =
          "http://private.example";
      if (change === "origin-credentials")
        config.bindings[0].environment.SCOUT_ODOO_URL =
          "https://user:secret@example.com";
      if (change === "duplicate-company")
        config.bindings[0].environment.SCOUT_ODOO_COMPANY_IDS = "1,1";
      if (change === "unsafe-uid")
        config.bindings[0].environment.SCOUT_ODOO_UID =
          "9999999999999999999999";
      expect(() => parseScoutBinding(config, actor)).toThrow(
        "SCOUT_NOT_CONFIGURED",
      );
    });
  }
  test("policy revision changes bind a new fingerprint; company ordering does not", () => {
    const config = scoutFixtureConfig();
    const original = parseScoutBinding(config, actor).fingerprint;
    config.bindings[0].environment.SCOUT_ODOO_COMPANY_IDS = "2,1";
    expect(parseScoutBinding(config, actor).fingerprint).toBe(original);
    config.policies[0].revision = config.bindings[0].policyRevision = 2;
    expect(parseScoutBinding(config, actor).fingerprint).not.toBe(original);
  });
  test("protected file is re-read, including revocation and malformed data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scout-binding-"));
    const path = join(directory, "binding.json");
    try {
      const config = scoutFixtureConfig();
      await writeFile(path, JSON.stringify(config), { mode: 0o600 });
      const read = createScoutBindingReader(path);
      expect((await read(actor)).userId).toBe(actor.id);
      config.bindings[0].active = false;
      await writeFile(path, JSON.stringify(config));
      await expect(read(actor)).rejects.toThrow("SCOUT_ACCESS_DENIED");
      await writeFile(path, "SYNTHETIC_PRIVATE_PARSE_ERROR");
      await expect(read(actor)).rejects.toThrow("SCOUT_NOT_CONFIGURED");
    } finally {
      await rm(path, { force: true });
      await rmdir(directory);
    }
  });
});
