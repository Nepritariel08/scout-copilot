import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { createScoutEntraAccountReader } from "../src/auth/scout-entra";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  auditEvents,
  sessions,
  userRoles,
  users,
} from "../src/db/schema";
import {
  scoutContextReleaseGrants,
  scoutOdooRecordAccessGrants,
} from "../src/db/schema/scout-record-context";
import {
  createEntraIdentityOperator,
  type EntraIdentityRequest,
  type EntraIdentityStore,
} from "../src/scout/entra-operator";
import {
  createEntraIdentityStore,
  ENTRA_OPERATOR_TARGET,
} from "../src/scout/entra-operator-store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

// Uses only the suite's explicit dedicated synthetic database. Never DATABASE_URL or a fallback.
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createEntraIdentityStore(database);
const tenantId = "8f2c1e40-0000-0000-0000-000000000000";
const operator = createEntraIdentityOperator(store, { tenantId });
const prefix = `entra-operator-${randomUUID()}`;
const userIds: string[] = [];
const accountReader = createScoutEntraAccountReader(database);

async function fixture(): Promise<EntraIdentityRequest> {
  const id = `${prefix}-${userIds.length}`;
  userIds.push(id);
  await database.insert(users).values({
    id,
    email: `${id}@fixture.invalid`,
    name: "Reviewed synthetic contact",
    groups: ["synthetic-existing-group"],
    emailVerified: false,
  });
  await database.insert(userRoles).values({ userId: id, role: "user" });
  const rows = await database.execute(
    sql`select current_database() as database, current_user as role`,
  );
  return {
    version: 1,
    operationId: randomUUID(),
    action: "enroll",
    target: rows[0] as EntraIdentityRequest["target"],
    tenantId,
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    objectId: randomUUID(),
    nativeUser: {
      id,
      email: `${id}@fixture.invalid`,
      name: "Reviewed synthetic contact",
    },
    review: {
      operatorUserId: "synthetic-operator",
      reference: "synthetic-only/review",
    },
  };
}
async function session(userId: string) {
  const id = `${prefix}-session-${randomUUID()}`;
  await database.insert(sessions).values({
    id,
    userId,
    token: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000),
  });
  return id;
}
async function snapshotNative(userId: string) {
  return {
    user: await database.select().from(users).where(eq(users.id, userId)),
    roles: await database
      .select()
      .from(userRoles)
      .where(eq(userRoles.userId, userId)),
    recordGrants: await database
      .select()
      .from(scoutOdooRecordAccessGrants)
      .where(eq(scoutOdooRecordAccessGrants.nativeUserId, userId)),
    releaseGrants: await database
      .select()
      .from(scoutContextReleaseGrants)
      .where(eq(scoutContextReleaseGrants.nativeUserId, userId)),
  };
}
async function receiptRows(operationId: string) {
  return database
    .select()
    .from(auditEvents)
    .where(
      sql`${auditEvents.targetType} = ${ENTRA_OPERATOR_TARGET} and ${auditEvents.targetId} = ${operationId}`,
    );
}
afterAll(async () => {
  if (userIds.length) {
    await database.delete(accounts).where(inArray(accounts.userId, userIds));
    await database.delete(users).where(inArray(users.id, userIds));
  }
  // Audit remains append-only, including synthetic operation receipts.
  await database.$client.end({ timeout: 5 });
});

describe("Entra operator PostgreSQL transaction boundary", () => {
  test("preview writes nothing; enrollment and repeat are exact and create no privileges or other grants", async () => {
    const input = await fixture();
    const other = await fixture();
    await session(input.nativeUser.id);
    const unrelatedSession = await session(other.nativeUser.id);
    const before = await snapshotNative(input.nativeUser.id);
    const { plan, digest } = await operator.preview(input);
    expect(await receiptRows(input.operationId)).toEqual([]);
    expect(
      await database
        .select()
        .from(accounts)
        .where(eq(accounts.userId, input.nativeUser.id)),
    ).toEqual([]);
    const result = await operator.apply(plan, digest);
    expect(result).toMatchObject({
      effect: "insert_binding",
      removedSessions: 1,
      replayed: false,
    });
    expect(await snapshotNative(input.nativeUser.id)).toEqual(before);
    const identities = await database
      .select()
      .from(accounts)
      .where(eq(accounts.userId, input.nativeUser.id));
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      providerId: "microsoft",
      issuer: input.issuer,
      accountId: input.objectId,
      userId: input.nativeUser.id,
      accessToken: null,
      refreshToken: null,
      idToken: null,
      password: null,
    });
    expect(
      await accountReader({ issuer: input.issuer, subject: input.objectId }),
    ).toMatchObject({
      userId: input.nativeUser.id,
      email: input.nativeUser.email,
    });
    expect(
      await database
        .select()
        .from(sessions)
        .where(eq(sessions.userId, input.nativeUser.id)),
    ).toEqual([]);
    expect(
      await database
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, unrelatedSession)),
    ).toEqual([{ id: unrelatedSession }]);
    const newSession = await session(input.nativeUser.id);
    expect(await operator.apply(plan, digest)).toMatchObject({
      replayed: true,
    });
    expect(await receiptRows(input.operationId)).toHaveLength(1);
    expect(
      await database
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, newSession)),
    ).toEqual([{ id: newSession }]);
    const [receipt] = await receiptRows(input.operationId);
    expect(receipt.actorUserId).toBeNull();
    expect(receipt.initiatorKind).toBe("deployment");
    for (const value of [
      input.nativeUser.id,
      input.nativeUser.email,
      input.objectId,
      input.issuer,
      input.review.reference,
    ])
      expect(JSON.stringify(receipt.payload)).not.toContain(value);
  });
  test("withdrawal removes the mapping and all target sessions without retiring unrelated accounts or native grants", async () => {
    const input = await fixture();
    const enrollment = await operator.preview(input);
    await operator.apply(enrollment.plan, enrollment.digest);
    const before = await snapshotNative(input.nativeUser.id);
    await session(input.nativeUser.id);
    await session(input.nativeUser.id);
    const withdrawal = await operator.preview({
      ...input,
      operationId: randomUUID(),
      action: "withdraw",
    });
    expect(
      await operator.apply(withdrawal.plan, withdrawal.digest),
    ).toMatchObject({ effect: "remove_binding", removedSessions: 2 });
    expect(
      await accountReader({ issuer: input.issuer, subject: input.objectId }),
    ).toBeNull();
    expect(
      await database
        .select()
        .from(sessions)
        .where(eq(sessions.userId, input.nativeUser.id)),
    ).toEqual([]);
    expect(await snapshotNative(input.nativeUser.id)).toEqual(before);
    expect(
      await operator.apply(withdrawal.plan, withdrawal.digest),
    ).toMatchObject({ replayed: true });
  });
  test.each(["legacy", "provider", "issuer", "foreign-user", "multiple"])(
    "refuses %s identity collisions without relink or partial effects",
    async (kind) => {
      const input = await fixture();
      const foreign = kind === "foreign-user" ? await fixture() : null;
      await database.insert(accounts).values({
        id: `${prefix}-${randomUUID()}`,
        userId: foreign?.nativeUser.id ?? input.nativeUser.id,
        providerId: kind === "provider" ? "different-provider" : "microsoft",
        issuer:
          kind === "legacy"
            ? null
            : kind === "issuer"
              ? "https://issuer.fixture.invalid"
              : input.issuer,
        accountId:
          kind === "legacy" ? `legacy-${randomUUID()}` : input.objectId,
      });
      if (kind === "multiple")
        await database.insert(accounts).values({
          id: `${prefix}-${randomUUID()}`,
          userId: input.nativeUser.id,
          providerId: "microsoft",
          issuer: input.issuer,
          accountId: randomUUID(),
        });
      const before = await database
        .select()
        .from(accounts)
        .where(eq(accounts.userId, input.nativeUser.id));
      await expect(operator.preview(input)).rejects.toThrow(
        "ENTRA_MAPPING_CONFLICT",
      );
      expect(
        await database
          .select()
          .from(accounts)
          .where(eq(accounts.userId, input.nativeUser.id)),
      ).toEqual(before);
      expect(await receiptRows(input.operationId)).toEqual([]);
    },
  );
  test("a session created after preview invalidates the plan and leaves both sessions and mapping intact", async () => {
    const input = await fixture();
    const preview = await operator.preview(input);
    const newSession = await session(input.nativeUser.id);
    await expect(operator.apply(preview.plan, preview.digest)).rejects.toThrow(
      "ENTRA_PLAN_STALE",
    );
    expect(
      await database
        .select()
        .from(accounts)
        .where(eq(accounts.userId, input.nativeUser.id)),
    ).toEqual([]);
    expect(
      await database
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, newSession)),
    ).toEqual([{ id: newSession }]);
    expect(await receiptRows(input.operationId)).toEqual([]);
  });
  test("audit failure after its insert rolls back binding, session deletion and the receipt together", async () => {
    const input = await fixture();
    const previousSession = await session(input.nativeUser.id);
    const failingStore: EntraIdentityStore = {
      read: store.read,
      write: (use) =>
        store.write((transaction) =>
          use({
            ...transaction,
            record: async (receipt) => {
              await transaction.record(receipt);
              throw new Error("synthetic rollback after audit insert");
            },
          }),
        ),
    };
    const failing = createEntraIdentityOperator(failingStore, { tenantId });
    const preview = await failing.preview(input);
    await expect(failing.apply(preview.plan, preview.digest)).rejects.toThrow(
      "ENTRA_OPERATOR_FAILED",
    );
    expect(
      await database
        .select()
        .from(accounts)
        .where(eq(accounts.userId, input.nativeUser.id)),
    ).toEqual([]);
    expect(
      await database
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, previousSession)),
    ).toEqual([{ id: previousSession }]);
    expect(await receiptRows(input.operationId)).toEqual([]);
  });
  test("two simultaneous retries serialize to one mapping and one durable receipt", async () => {
    const input = await fixture();
    const { plan, digest } = await operator.preview(input);
    const results = await Promise.all([
      operator.apply(plan, digest),
      operator.apply(plan, digest),
    ]);
    expect(results.map((row) => row.replayed).sort()).toEqual([false, true]);
    expect(
      await database
        .select()
        .from(accounts)
        .where(eq(accounts.userId, input.nativeUser.id)),
    ).toHaveLength(1);
    expect(await receiptRows(input.operationId)).toHaveLength(1);
  });
  test("the maintenance lock also fences a native writer that does not use operator advisory locks", async () => {
    const input = await fixture();
    await store.write(async () => {
      const failure = await database
        .transaction(async (transaction) => {
          await transaction.execute(sql`set local lock_timeout = '150ms'`);
          await transaction
            .update(users)
            .set({ name: "Must be rolled back" })
            .where(eq(users.id, input.nativeUser.id));
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      const driver =
        typeof failure === "object" && failure !== null && "cause" in failure
          ? failure.cause
          : failure;
      expect(
        typeof driver === "object" && driver !== null && "errno" in driver
          ? driver.errno
          : undefined,
      ).toBe("55P03");
    });
    expect((await snapshotNative(input.nativeUser.id)).user[0]?.name).toBe(
      input.nativeUser.name,
    );
  });
});
