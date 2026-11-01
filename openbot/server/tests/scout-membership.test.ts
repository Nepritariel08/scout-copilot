import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createScoutMembershipReader,
  parseScoutMembership,
} from "../src/scout/membership";

export function membershipFixture() {
  return {
    version: 1,
    deploymentId: "scout-test",
    policies: [
      {
        tenantId: "tenant-a",
        revision: 1,
        active: true,
        expiresAt: "2099-01-01T00:00:00Z",
      },
    ],
    memberships: [
      {
        userId: "scout-fixture-alice",
        tenantId: "tenant-a",
        revision: 1,
        policyRevision: 1,
        active: true,
        expiresAt: "2099-01-01T00:00:00Z",
      },
    ],
  };
}
const actor = { id: "scout-fixture-alice" };
const parse = (input: unknown) =>
  parseScoutMembership(input, actor, "scout-test");

describe("protected native membership without delegated authority", () => {
  test("admits only the exact native subject/deployment and returns no queue or source authority", () => {
    const member = parse(membershipFixture());
    expect(Object.keys(member).sort()).toEqual([
      "deploymentId",
      "expiresAt",
      "fingerprint",
      "tenantId",
      "userId",
    ]);
    expect(member.tenantId).toBe("tenant-a");
    expect(member.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      parseScoutMembership(
        membershipFixture(),
        { id: "alice@example.com" },
        "scout-test",
      ),
    ).toThrow("SCOUT_ACCESS_DENIED");
    expect(() =>
      parseScoutMembership(membershipFixture(), actor, "other-deployment"),
    ).toThrow("SCOUT_ACCESS_DENIED");
  });
  test("revocation, expiry and stale tenant revision deny", () => {
    const mutations = [
      (value: ReturnType<typeof membershipFixture>) => {
        value.memberships[0].active = false;
      },
      (value: ReturnType<typeof membershipFixture>) => {
        value.policies[0].active = false;
      },
      (value: ReturnType<typeof membershipFixture>) => {
        value.memberships[0].expiresAt = "2000-01-01T00:00:00Z";
      },
      (value: ReturnType<typeof membershipFixture>) => {
        value.policies[0].expiresAt = "2000-01-01T00:00:00Z";
      },
      (value: ReturnType<typeof membershipFixture>) => {
        value.policies[0].revision++;
      },
      (value: ReturnType<typeof membershipFixture>) => {
        value.memberships = [];
      },
    ];
    for (const mutate of mutations) {
      const value = membershipFixture();
      mutate(value);
      expect(() => parse(value)).toThrow("SCOUT_ACCESS_DENIED");
    }
  });
  test("missing, ambiguous, unknown and queue-shaped configuration cannot supply native membership", () => {
    const value = membershipFixture();
    for (const malformed of [
      null,
      {},
      { ...value, version: 2 },
      { ...value, bindings: value.memberships },
      { ...value, policies: [...value.policies, value.policies[0]] },
      { ...value, memberships: [...value.memberships, value.memberships[0]] },
      {
        ...value,
        memberships: [{ ...value.memberships[0], tenantId: "unknown" }],
      },
      {
        ...value,
        memberships: [{ ...value.memberships[0], userId: " alice " }],
      },
      { ...value, memberships: [{ ...value.memberships[0], revision: 0 }] },
      { ...value, policies: [{ ...value.policies[0], draftAnalysis: true }] },
      {
        ...value,
        memberships: [{ ...value.memberships[0], command: ["python"] }],
      },
    ])
      expect(() => parse(malformed)).toThrow("SCOUT_NOT_CONFIGURED");
  });
  test("selected membership and tenant revisions/expiry change the fingerprint, unrelated users do not", () => {
    const value = membershipFixture();
    const original = parse(value).fingerprint;
    value.memberships.push({ ...value.memberships[0], userId: "unrelated" });
    expect(parse(value).fingerprint).toBe(original);
    value.memberships[0].revision++;
    expect(parse(value).fingerprint).not.toBe(original);
    value.memberships[0].revision--;
    value.policies[0].revision = value.memberships[0].policyRevision = 2;
    expect(parse(value).fingerprint).not.toBe(original);
    value.policies[0].expiresAt = "2098-01-01T00:00:00Z";
    expect(parse(value).expiresAt).toBe("2098-01-01T00:00:00.000Z");
    expect(parse(value).fingerprint).not.toBe(original);
  });
  test("reopens the actual protected file for current grants, revocation, expiry, malformed and oversized data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scout-membership-"));
    const path = join(directory, "memberships.json");
    try {
      const value = membershipFixture();
      await writeFile(path, JSON.stringify(value), { mode: 0o600 });
      const reader = createScoutMembershipReader(path, "scout-test");
      const original = await reader(actor);
      value.memberships[0].revision++;
      await writeFile(path, JSON.stringify(value));
      expect((await reader(actor)).fingerprint).not.toBe(original.fingerprint);
      value.memberships[0].active = false;
      await writeFile(path, JSON.stringify(value));
      await expect(reader(actor)).rejects.toThrow("SCOUT_ACCESS_DENIED");
      value.memberships[0].active = true;
      value.policies[0].expiresAt = "2000-01-01T00:00:00Z";
      await writeFile(path, JSON.stringify(value));
      await expect(reader(actor)).rejects.toThrow("SCOUT_ACCESS_DENIED");
      await writeFile(path, "SYNTHETIC_PRIVATE_PARSE_ERROR");
      await expect(reader(actor)).rejects.toThrow("SCOUT_NOT_CONFIGURED");
      await writeFile(path, " ".repeat(65537));
      await expect(reader(actor)).rejects.toThrow("SCOUT_NOT_CONFIGURED");
      await expect(
        createScoutMembershipReader("relative.json", "scout-test")(actor),
      ).rejects.toThrow("SCOUT_NOT_CONFIGURED");
      await expect(
        createScoutMembershipReader(directory, "scout-test")(actor),
      ).rejects.toThrow("SCOUT_NOT_CONFIGURED");
      if (process.platform !== "win32") {
        await writeFile(path, JSON.stringify(membershipFixture()));
        await chmod(path, 0o644);
        await expect(reader(actor)).rejects.toThrow("SCOUT_NOT_CONFIGURED");
        await chmod(path, 0o600);
        const alias = join(directory, "alias.json");
        await symlink(path, alias);
        await expect(
          createScoutMembershipReader(alias, "scout-test")(actor),
        ).rejects.toThrow("SCOUT_NOT_CONFIGURED");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
