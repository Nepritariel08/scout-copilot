import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { historyDigest } from "../src/scout/history/protocol";
import {
  createModelPolicyReader,
  type ModelGrant,
  openRouterOwnedPreferences,
  PAID_PHALA_PROFILE,
  parseModelPolicy,
  readModelKey,
  readProtectedModelFile,
} from "../src/scout/owned-model/policy";

let directory = "";
const principal = {
  userId: "native-alice",
  tenantId: "tenant-a",
  deploymentId: "scout-pilot",
  agentId: "scout",
};
const policy = () => ({
  version: 1,
  deploymentId: "scout-pilot",
  globalMaxConcurrent: 2,
  globalMaxCallsPerDay: 100,
  bindings: [
    {
      userId: principal.userId,
      tenantId: principal.tenantId,
      active: true,
      revision: 1,
      expiresAt: "2099-01-01T00:00:00Z",
      agentIds: ["scout"],
      allowConversationContext: true,
      allowPersonalInstructions: false,
      route: {
        provider: "openrouter",
        model: "openrouter/free",
        apiKeyFile: join(directory, "synthetic-key"),
      },
      limits: {
        maxInputBytes: 8192,
        maxOutputTokens: 64,
        maxOutputBytes: 4096,
        maxCallsPerRun: 1,
        maxCallsPerDay: 20,
        maxConcurrent: 1,
        timeoutMs: 5000,
      },
    },
  ],
});
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "scout-model-policy-"));
});
afterAll(async () => {
  if (
    dirname(directory) === tmpdir() &&
    basename(directory).startsWith("scout-model-policy-")
  )
    await rm(directory, { recursive: true, force: true });
});
describe("operator-owned model and context policy", () => {
  test("fixed public computer tools require explicit unique names and a budgeted follow-up", () => {
    for (const allowedToolNames of [
      ["scout_computer_read_public"],
      ["scout_capabilities", "scout_computer_read_public"],
    ] satisfies NonNullable<ModelGrant["allowedToolNames"]>[]) {
      const config = policy();
      Object.assign(config.bindings[0], { allowedToolNames });
      expect(() => parseModelPolicy(config, principal)).toThrow(
        "MODEL_NOT_CONFIGURED",
      );
      config.bindings[0].limits.maxCallsPerRun = 2;
      expect(parseModelPolicy(config, principal).allowedToolNames).toEqual(
        allowedToolNames,
      );
    }
    for (const allowedToolNames of [
      ["scout_computer_read_public", "scout_computer_read_public"],
      ["scout_computer_read_public", "computer_navigate"],
    ]) {
      const config = policy();
      Object.assign(config.bindings[0], { allowedToolNames });
      config.bindings[0].limits.maxCallsPerRun = 2;
      expect(() => parseModelPolicy(config, principal)).toThrow(
        "MODEL_NOT_CONFIGURED",
      );
    }
  });
  test("status tools are an exact protected opt-in and leave absent policy fingerprints unchanged", () => {
    const original = policy();
    expect(parseModelPolicy(original, principal).fingerprint).toBe(
      historyDigest(original),
    );
    expect(parseModelPolicy(original, principal)).not.toHaveProperty(
      "allowedToolNames",
    );
    for (const allowedToolNames of [
      [],
      ["other_tool"],
      ["scout_capabilities", "scout_capabilities"],
      ["scout_capabilities", "other_tool"],
    ]) {
      const config = policy();
      Object.assign(config.bindings[0], { allowedToolNames });
      config.bindings[0].limits.maxCallsPerRun = 2;
      expect(() => parseModelPolicy(config, principal)).toThrow(
        "MODEL_NOT_CONFIGURED",
      );
    }
    const enabled = policy();
    Object.assign(enabled.bindings[0], {
      allowedToolNames: ["scout_capabilities"],
    });
    expect(() => parseModelPolicy(enabled, principal)).toThrow(
      "MODEL_NOT_CONFIGURED",
    );
    enabled.bindings[0].limits.maxCallsPerRun = 2;
    expect(parseModelPolicy(enabled, principal).allowedToolNames).toEqual([
      "scout_capabilities",
    ]);
    expect(parseModelPolicy(enabled, principal).fingerprint).not.toBe(
      historyDigest(original),
    );
  });
  test("absent paid profile preserves the original fingerprint and exact free preferences", () => {
    const original = policy();
    const grant = parseModelPolicy(original, principal);
    expect(grant.fingerprint).toBe(historyDigest(original));
    expect(grant.route).not.toHaveProperty("paidProfile");
    expect(openRouterOwnedPreferences(grant)).toEqual({
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: "deny",
      zdr: true,
      max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
    });
  });
  test("the fixed paid profile binds one model and changes the consent fingerprint", () => {
    const original = policy();
    const paid = policy();
    Object.assign(paid.bindings[0].route, {
      model: PAID_PHALA_PROFILE.model,
      paidProfile: PAID_PHALA_PROFILE.id,
    });
    paid.bindings[0].limits.maxOutputTokens = 512;
    paid.bindings[0].limits.timeoutMs = 30000;
    const grant = parseModelPolicy(paid, principal);
    expect(grant.fingerprint).not.toBe(
      parseModelPolicy(original, principal).fingerprint,
    );
    expect(openRouterOwnedPreferences(grant)).toEqual({
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: "deny",
      zdr: true,
      only: ["phala"],
      max_price: { prompt: 0.1, completion: 0.2, request: 0, image: 0 },
    });
    for (const changed of [
      { model: "openrouter/free" },
      { paidProfile: "unapproved-profile" },
      { max_price: { prompt: 100 } },
      { paidProfile: null },
      { provider: "local", baseUrl: "http://127.0.0.1:11434/v1" },
    ]) {
      const value = structuredClone(paid);
      Object.assign(value.bindings[0].route, changed);
      expect(() => parseModelPolicy(value, principal)).toThrow(
        "MODEL_NOT_CONFIGURED",
      );
    }
    for (const changed of [{ maxOutputTokens: 513 }, { timeoutMs: 30001 }]) {
      const value = structuredClone(paid);
      Object.assign(value.bindings[0].limits, changed);
      expect(() => parseModelPolicy(value, principal)).toThrow(
        "MODEL_NOT_CONFIGURED",
      );
    }
  });
  test("uses exact native subject/tenant/deployment/agent binding, never an email or browser route", () => {
    expect(parseModelPolicy(policy(), principal).route.model).toBe(
      "openrouter/free",
    );
    for (const changed of [
      { userId: "same-email-foreign" },
      { tenantId: "tenant-b" },
      { deploymentId: "another-host" },
      { agentId: "ungranted-agent" },
    ])
      expect(() =>
        parseModelPolicy(policy(), { ...principal, ...changed }),
      ).toThrow("MODEL_ACCESS_DENIED");
    expect(() =>
      parseModelPolicy(
        { ...policy(), apiKey: "synthetic-untrusted-field" },
        principal,
      ),
    ).toThrow("MODEL_NOT_CONFIGURED");
  });
  test("duplicates, revoked/expired policies and unapproved context cannot grant model access", () => {
    const original = policy();
    expect(() =>
      parseModelPolicy(
        { ...original, bindings: [...original.bindings, ...original.bindings] },
        principal,
      ),
    ).toThrow("MODEL_NOT_CONFIGURED");
    for (const changed of [
      { active: false },
      { expiresAt: "2000-01-01T00:00:00Z" },
    ])
      expect(() =>
        parseModelPolicy(
          { ...original, bindings: [{ ...original.bindings[0], ...changed }] },
          principal,
        ),
      ).toThrow("MODEL_ACCESS_DENIED");
    expect(() =>
      parseModelPolicy(
        {
          ...original,
          bindings: [
            { ...original.bindings[0], allowConversationContext: false },
          ],
        },
        principal,
      ),
    ).toThrow("MODEL_NOT_CONFIGURED");
  });
  test("model limits cannot become unbounded, and local routes cannot redirect credentials through arbitrary URLs", () => {
    const original = policy();
    expect(() =>
      parseModelPolicy({ ...original, globalMaxConcurrent: 0 }, principal),
    ).toThrow("MODEL_NOT_CONFIGURED");
    expect(() =>
      parseModelPolicy(
        {
          ...original,
          bindings: [
            {
              ...original.bindings[0],
              limits: { ...original.bindings[0].limits, maxCallsPerRun: 1000 },
            },
          ],
        },
        principal,
      ),
    ).toThrow("MODEL_NOT_CONFIGURED");
    for (const baseUrl of [
      "http://169.254.169.254/v1",
      "http://model.example/v1",
      "https://user:secret@model.example/v1",
      "https://model.example/v1?route=secret",
      "https://model.example/v1#key",
    ])
      expect(() =>
        parseModelPolicy(
          {
            ...original,
            bindings: [
              {
                ...original.bindings[0],
                route: { provider: "local", model: "local-fixture", baseUrl },
              },
            ],
          },
          principal,
        ),
      ).toThrow("MODEL_NOT_CONFIGURED");
    expect(
      parseModelPolicy(
        {
          ...original,
          bindings: [
            {
              ...original.bindings[0],
              route: {
                provider: "local",
                model: "local-fixture",
                baseUrl: "http://127.0.0.1:11434/v1",
              },
            },
          ],
        },
        principal,
      ).route.provider,
    ).toBe("local");
  });
  test("protected policy is reloaded for each call and malformed/oversized files produce no secret/path disclosure", async () => {
    const path = join(directory, "policy.json");
    await writeFile(path, JSON.stringify(policy()), { mode: 0o600 });
    const read = createModelPolicyReader(path);
    const first = await read(principal);
    const changed = policy();
    changed.bindings[0].active = false;
    await writeFile(path, JSON.stringify(changed));
    await expect(read(principal)).rejects.toThrow("MODEL_ACCESS_DENIED");
    await writeFile(path, "synthetic-private-token");
    await expect(read(principal)).rejects.toThrow(/^MODEL_NOT_CONFIGURED$/);
    await writeFile(path, "x".repeat(65537));
    await expect(read(principal)).rejects.toThrow(/^MODEL_NOT_CONFIGURED$/);
    expect(first.fingerprint).toHaveLength(64);
  });
  test("key file is explicit, bounded and reloaded without environment fallback", async () => {
    const grant = parseModelPolicy(policy(), principal);
    if (!grant.route.apiKeyFile) throw new Error("Fixture key file missing");
    await expect(readModelKey(grant)).rejects.toThrow("MODEL_NOT_CONFIGURED");
    await writeFile(grant.route.apiKeyFile, "synthetic-fixture-key\n", {
      mode: 0o600,
    });
    expect(await readModelKey(grant)).toBe("synthetic-fixture-key");
    await writeFile(grant.route.apiKeyFile, "rotated-fixture-key\n");
    expect(await readModelKey(grant)).toBe("rotated-fixture-key");
    await writeFile(grant.route.apiKeyFile, "header\ninjection");
    await expect(readModelKey(grant)).rejects.toThrow(/^MODEL_NOT_CONFIGURED$/);
    if (process.platform !== "win32") {
      await chmod(grant.route.apiKeyFile, 0o644);
      await expect(readModelKey(grant)).rejects.toThrow(
        /^MODEL_NOT_CONFIGURED$/,
      );
      const link = join(directory, "policy-link");
      await symlink(grant.route.apiKeyFile, link);
      await expect(readProtectedModelFile(link)).rejects.toThrow(
        /^MODEL_NOT_CONFIGURED$/,
      );
    }
  });
});
