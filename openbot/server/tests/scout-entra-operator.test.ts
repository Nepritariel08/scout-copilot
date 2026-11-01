import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  parseEntraOperatorArguments,
  readBoundedEntraJson,
  runEntraOperator,
} from "../scripts/scout-entra-operator";
import {
  createEntraIdentityOperator,
  type EntraIdentityReceipt,
  type EntraIdentityRequest,
  type EntraIdentitySnapshot,
  type EntraIdentityStore,
  type EntraIdentityTransaction,
  entraIdentityDigest,
  parseEntraIdentityRequest,
} from "../src/scout/entra-operator";

const now = Date.parse("2026-11-02T10:00:00Z");
const tenantId = "8f2c1e40-0000-0000-0000-000000000000";
function request(
  action: "enroll" | "withdraw" = "enroll",
): EntraIdentityRequest {
  return {
    version: 1,
    operationId: randomUUID(),
    action,
    target: { database: "scout_operator_test", role: "scout_operator_test" },
    tenantId,
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    objectId: "4e70e6f1-0000-0000-0000-000000000000",
    nativeUser: {
      id: "synthetic-native-user",
      email: "synthetic@fixture.invalid",
      name: "Synthetic person",
    },
    review: {
      operatorUserId: "synthetic-operator",
      reference: "synthetic-review/42",
    },
  };
}
function fixture() {
  const input = request();
  let snapshot: EntraIdentitySnapshot = {
    target: { ...input.target, serverAddress: "127.0.0.1", serverPort: 55499 },
    user: {
      ...input.nativeUser,
      emailVerified: false,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    },
    revoked: false,
    accounts: [],
    sessions: [
      {
        id: "prior-session",
        createdAt: "2026-11-01T00:00:00.000Z",
        expiresAt: "2026-11-03T00:00:00.000Z",
      },
    ],
  };
  let receipts: EntraIdentityReceipt[] = [];
  let writes = 0;
  let clock = now;
  let failAudit = false;
  const transaction: EntraIdentityTransaction = {
    snapshot: async () => structuredClone(snapshot),
    receipt: async (id) =>
      structuredClone(receipts.find((row) => row.operationId === id) ?? null),
    async insertBinding(value) {
      writes++;
      snapshot.accounts.push({
        id: `scout-entra-${value.operationId}`,
        userId: value.nativeUser.id,
        providerId: "microsoft",
        issuer: value.issuer,
        accountId: value.objectId,
        createdAt: new Date(clock).toISOString(),
        updatedAt: new Date(clock).toISOString(),
      });
    },
    async removeBinding(id) {
      writes++;
      snapshot.accounts = snapshot.accounts.filter((row) => row.id !== id);
    },
    async removeSessions() {
      writes++;
      const count = snapshot.sessions.length;
      snapshot.sessions = [];
      return count;
    },
    async record(receipt) {
      writes++;
      if (failAudit)
        throw new Error(
          "postgres://secret:password@private.invalid failed; raw token",
        );
      receipts.push(structuredClone(receipt));
    },
  };
  const store: EntraIdentityStore = {
    read: async (use) => use(transaction),
    write: async (use) => {
      const before = structuredClone({ snapshot, receipts });
      try {
        return await use(transaction);
      } catch (error) {
        snapshot = before.snapshot;
        receipts = before.receipts;
        throw error;
      }
    },
  };
  const operator = createEntraIdentityOperator(store, {
    tenantId,
    now: () => clock,
  });
  return {
    input,
    operator,
    state: () => structuredClone({ snapshot, receipts, writes }),
    mutate: (use: (value: EntraIdentitySnapshot) => void) => use(snapshot),
    clock: (value: number) => {
      clock = value;
    },
    failAudit: () => {
      failAudit = true;
    },
  };
}

describe("Entra identity operator exact-plan boundary", () => {
  test("preview is read only; apply adds only the exact account and clears old sessions", async () => {
    const subject = fixture();
    const original = subject.state();
    const { plan, digest } = await subject.operator.preview(subject.input);
    expect(subject.state()).toEqual(original);
    expect(plan.effect).toBe("insert_binding");
    expect(digest).toBe(entraIdentityDigest(JSON.parse(JSON.stringify(plan))));
    const applied = await subject.operator.apply(plan, digest);
    expect(applied).toMatchObject({
      effect: "insert_binding",
      removedSessions: 1,
      replayed: false,
    });
    const after = subject.state();
    expect(after.snapshot.user).toEqual(original.snapshot.user);
    expect(after.snapshot.accounts).toEqual([
      expect.objectContaining({
        providerId: "microsoft",
        issuer: subject.input.issuer,
        accountId: subject.input.objectId,
        userId: subject.input.nativeUser.id,
      }),
    ]);
    expect(after.snapshot.sessions).toEqual([]);
    expect(after.receipts).toHaveLength(1);
    const output = JSON.stringify({ applied, receipts: after.receipts });
    for (const privateValue of [
      subject.input.nativeUser.id,
      subject.input.nativeUser.email,
      subject.input.nativeUser.name,
      subject.input.objectId,
      subject.input.issuer,
      subject.input.review.operatorUserId,
      subject.input.review.reference,
    ])
      expect(output).not.toContain(privateValue as string);
  });
  test("repeating the same valid plan reads its receipt without creating an account, audit row or deleting a new login", async () => {
    const subject = fixture();
    const { plan, digest } = await subject.operator.preview(subject.input);
    await subject.operator.apply(plan, digest);
    subject.mutate((value) => {
      value.sessions.push({
        id: "new-login",
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
      });
    });
    const before = subject.state();
    expect(await subject.operator.apply(plan, digest)).toMatchObject({
      replayed: true,
    });
    expect(subject.state()).toEqual(before);
    await expect(subject.operator.preview(subject.input)).rejects.toThrow(
      "ENTRA_OPERATION_CONFLICT",
    );
  });
  test("an operation ID cannot be reused for a changed reviewed payload", async () => {
    const subject = fixture();
    const { plan, digest } = await subject.operator.preview(subject.input);
    await subject.operator.apply(plan, digest);
    const changed = {
      ...plan,
      request: {
        ...plan.request,
        review: { ...plan.request.review, reference: "different-review" },
      },
    };
    await expect(
      subject.operator.apply(changed, entraIdentityDigest(changed)),
    ).rejects.toThrow("ENTRA_OPERATION_CONFLICT");
  });
  test("withdrawal deletes the exact binding and all target sessions, with an idempotent receipt", async () => {
    const subject = fixture();
    const enrollment = await subject.operator.preview(subject.input);
    await subject.operator.apply(enrollment.plan, enrollment.digest);
    subject.mutate((value) => {
      value.sessions = [
        {
          id: "live-session",
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString(),
        },
      ];
    });
    const withdrawal = await subject.operator.preview({
      ...subject.input,
      operationId: randomUUID(),
      action: "withdraw",
    });
    const beforeUser = subject.state().snapshot.user;
    expect(
      await subject.operator.apply(withdrawal.plan, withdrawal.digest),
    ).toMatchObject({
      effect: "remove_binding",
      removedSessions: 1,
      replayed: false,
    });
    expect(subject.state().snapshot).toMatchObject({
      accounts: [],
      sessions: [],
      user: beforeUser,
    });
    expect(
      await subject.operator.apply(withdrawal.plan, withdrawal.digest),
    ).toMatchObject({ replayed: true });
    subject.mutate((value) => {
      value.sessions.push({
        id: "reappeared",
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
      });
    });
    await expect(
      subject.operator.apply(withdrawal.plan, withdrawal.digest),
    ).rejects.toThrow("ENTRA_POSTCONDITION_REFUSED");
  });
  test("withdrawal can clear orphan sessions when the binding is already absent", async () => {
    const subject = fixture();
    const { plan, digest } = await subject.operator.preview({
      ...subject.input,
      action: "withdraw",
    });
    expect(await subject.operator.apply(plan, digest)).toMatchObject({
      effect: "binding_unchanged",
      removedSessions: 1,
    });
  });
  test.each([
    { name: "different provider", change: { providerId: "other-provider" } },
    {
      name: "different issuer",
      change: { issuer: "https://issuer.fixture.invalid" },
    },
    { name: "legacy null issuer", change: { issuer: null } },
    {
      name: "legacy pairwise subject",
      change: { accountId: "old-pairwise-sub" },
    },
    { name: "another native user", change: { userId: "other-user" } },
    {
      name: "noncanonical object ID",
      change: { accountId: "4E70E6F1-0000-0000-0000-000000000000" },
    },
  ])("refuses $name rather than relinking", async ({ change }) => {
    const subject = fixture();
    subject.mutate((value) => {
      value.accounts = [
        {
          id: "conflicting-account",
          userId: subject.input.nativeUser.id,
          accountId: subject.input.objectId,
          providerId: "microsoft",
          issuer: subject.input.issuer,
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
          ...change,
        },
      ];
    });
    const before = subject.state();
    for (const action of ["enroll", "withdraw"])
      await expect(
        subject.operator.preview({ ...subject.input, action }),
      ).rejects.toThrow("ENTRA_MAPPING_CONFLICT");
    expect(subject.state()).toEqual(before);
  });
  test("two matching identities are ambiguous even if they name the same native user", async () => {
    const subject = fixture();
    const enrollment = await subject.operator.preview(subject.input);
    await subject.operator.apply(enrollment.plan, enrollment.digest);
    subject.mutate((value) => {
      value.accounts.push({ ...value.accounts[0], id: "second-account" });
    });
    await expect(
      subject.operator.preview({ ...subject.input, operationId: randomUUID() }),
    ).rejects.toThrow("ENTRA_MAPPING_CONFLICT");
  });
  test.each(["id", "email", "name"] as const)(
    "contact %s must match exactly; email never finds another account",
    async (field) => {
      const subject = fixture();
      const nativeUser = {
        ...subject.input.nativeUser,
        [field]: field === "email" ? "other@fixture.invalid" : "other",
      };
      await expect(
        subject.operator.preview({ ...subject.input, nativeUser }),
      ).rejects.toThrow("ENTRA_CONTACT_REFUSED");
    },
  );
  test("a missing or administratively revoked native account cannot be enrolled", async () => {
    for (const revoked of [false, true]) {
      const subject = fixture();
      subject.mutate((value) => {
        value.revoked = revoked;
        if (!revoked) value.user = null;
      });
      await expect(subject.operator.preview(subject.input)).rejects.toThrow(
        "ENTRA_CONTACT_REFUSED",
      );
    }
  });
  test("a different resource tenant or DB role is denied", async () => {
    const subject = fixture();
    const anotherTenant = "8f2c1e40-1111-0000-0000-000000000000";
    await expect(
      subject.operator.preview({
        ...subject.input,
        tenantId: anotherTenant,
        issuer: `https://login.microsoftonline.com/${anotherTenant}/v2.0`,
      }),
    ).rejects.toThrow("ENTRA_TARGET_REFUSED");
    subject.mutate((value) => {
      value.target.role = "wrong-role";
    });
    await expect(subject.operator.preview(subject.input)).rejects.toThrow(
      "ENTRA_TARGET_REFUSED",
    );
  });
  test.each([
    { role: "admin" },
    { password: "secret" },
    { apiKey: "secret" },
    { memberOf: "all" },
    { objectId: "user@fixture.invalid" },
    { issuer: "https://login.microsoftonline.com/common/v2.0" },
  ])("strict input refuses unintended fields or identity aliases", (extra) => {
    expect(() => parseEntraIdentityRequest({ ...request(), ...extra })).toThrow(
      "ENTRA_INPUT_REFUSED",
    );
  });
  test.each(["contact", "session", "account", "database", "revoke"] as const)(
    "changes after preview (%s) invalidate apply",
    async (kind) => {
      const subject = fixture();
      const preview = await subject.operator.preview(subject.input);
      subject.mutate((value) => {
        if (kind === "contact" && value.user)
          value.user.updatedAt = new Date(now).toISOString();
        if (kind === "session") value.sessions = [];
        if (kind === "account")
          value.accounts.push({
            id: "new-exact",
            userId: subject.input.nativeUser.id,
            accountId: subject.input.objectId,
            providerId: "microsoft",
            issuer: subject.input.issuer,
            createdAt: new Date(now).toISOString(),
            updatedAt: new Date(now).toISOString(),
          });
        if (kind === "database") value.target.serverPort = 54321;
        if (kind === "revoke") value.revoked = true;
      });
      const before = subject.state();
      await expect(
        subject.operator.apply(preview.plan, preview.digest),
      ).rejects.toThrow(
        kind === "revoke" ? "ENTRA_CONTACT_REFUSED" : "ENTRA_PLAN_STALE",
      );
      expect(subject.state()).toEqual(before);
    },
  );
  test("tampered, wrongly approved, expired or future plans cannot apply", async () => {
    const subject = fixture();
    const preview = await subject.operator.preview(subject.input);
    await expect(
      subject.operator.apply(preview.plan, "0".repeat(64)),
    ).rejects.toThrow("ENTRA_PLAN_REFUSED");
    await expect(
      subject.operator.apply(
        { ...preview.plan, effect: "binding_unchanged" },
        preview.digest,
      ),
    ).rejects.toThrow("ENTRA_PLAN_REFUSED");
    const wrongEffect = { ...preview.plan, effect: "binding_unchanged" };
    await expect(
      subject.operator.apply(wrongEffect, entraIdentityDigest(wrongEffect)),
    ).rejects.toThrow("ENTRA_PLAN_REFUSED");
    subject.clock(now - 1);
    await expect(
      subject.operator.apply(preview.plan, preview.digest),
    ).rejects.toThrow("ENTRA_PLAN_REFUSED");
    subject.clock(now + 15 * 60_000);
    await expect(
      subject.operator.apply(preview.plan, preview.digest),
    ).rejects.toThrow("ENTRA_PLAN_REFUSED");
    expect(subject.state().writes).toBe(0);
  });
  test("audit failure rolls back the mapping/session changes and exposes no driver error", async () => {
    const subject = fixture();
    const preview = await subject.operator.preview(subject.input);
    const original = subject.state();
    subject.failAudit();
    await expect(
      subject.operator.apply(preview.plan, preview.digest),
    ).rejects.toThrow(/^ENTRA_OPERATOR_FAILED$/);
    expect(subject.state().snapshot).toEqual(original.snapshot);
    expect(subject.state().receipts).toEqual([]);
  });
});

describe("operator CLI admission", () => {
  test("bounded input handles short reads and refuses growth beyond 64 KiB", async () => {
    function file(content: string, chunkSize: number) {
      const input = Buffer.from(content, "utf8");
      let read = 0;
      return {
        bytesRead: () => read,
        async read(buffer: Buffer, offset: number, length: number) {
          const count = Math.min(chunkSize, length, input.length - read);
          input.copy(buffer, offset, read, read + count);
          read += count;
          return { bytesRead: count };
        },
      };
    }
    expect(await readBoundedEntraJson(file('{"version":1}', 3))).toEqual({
      version: 1,
    });
    expect(
      await readBoundedEntraJson(file(`"${"a".repeat(65_534)}"`, 101)),
    ).toHaveLength(65_534);
    const growing = file(`"${"a".repeat(80_000)}"`, 101);
    await expect(readBoundedEntraJson(growing)).rejects.toThrow(
      "ENTRA_INPUT_REFUSED",
    );
    expect(growing.bytesRead()).toBe(65_537);
  });
  test("omitted verb means preview, and apply requires an exact digest", () => {
    const root = process.platform === "win32" ? "C:\\private\\" : "/private/";
    expect(
      parseEntraOperatorArguments([
        "--request",
        `${root}request.json`,
        "--plan",
        `${root}plan.json`,
      ]),
    ).toMatchObject({ mode: "preview" });
    expect(
      parseEntraOperatorArguments([
        "apply",
        "--plan",
        `${root}plan.json`,
        "--approve",
        "a".repeat(64),
      ]),
    ).toMatchObject({ mode: "apply" });
    for (const args of [
      [],
      ["apply"],
      ["preview", "--request", "relative"],
      ["apply", "--plan", `${root}plan.json`, "--approve", "wrong"],
      ["apply", "--plan", `${root}plan.json`, "--password", "secret"],
      ["preview", "--plan", `${root}plan.json`, "--plan", `${root}plan.json`],
    ])
      expect(() => parseEntraOperatorArguments(args)).toThrow(
        "ENTRA_INPUT_REFUSED",
      );
  });
  test("missing protected owned configuration fails before any file/database access", async () => {
    const root =
      process.platform === "win32" ? "C:\\nonexistent\\" : "/nonexistent/";
    await expect(
      runEntraOperator(
        [
          "preview",
          "--request",
          `${root}request.json`,
          "--plan",
          `${root}plan.json`,
        ],
        {},
      ),
    ).rejects.toThrow("ENTRA_TARGET_REFUSED");
  });
});
