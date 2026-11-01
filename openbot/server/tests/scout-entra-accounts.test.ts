import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createScoutEntraAccountReader } from "../src/auth/scout-entra";
import { createDatabase } from "../src/db/client";
import { accounts, users } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `scout-entra-accounts-${randomUUID()}`;
const userId = `${prefix}-native-owner`;
const tenantId = "8f2c1e40-0000-0000-0000-000000000000";
const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
const email = `${prefix}@fixture.example`;
const subject = "4e70e6f1-0000-0000-0000-000000000000";
const reader = createScoutEntraAccountReader(database);

afterAll(async () => {
  await database
    .delete(accounts)
    .where(
      inArray(accounts.id, [
        `${prefix}-exact`,
        `${prefix}-legacy`,
        `${prefix}-other-provider`,
        `${prefix}-other-issuer`,
      ]),
    );
  await database.delete(users).where(eq(users.id, userId));
  await database.$client.end({ timeout: 5 });
});

describe("owned Entra preprovisioned account lookup", () => {
  test("requires exact provider, resource issuer and tenant-scoped object key", async () => {
    await database.insert(users).values({
      id: userId,
      email,
      name: "Provisioned person",
      emailVerified: false,
    });
    await database.insert(accounts).values([
      {
        id: `${prefix}-exact`,
        userId,
        providerId: "microsoft",
        issuer,
        accountId: subject,
      },
      {
        id: `${prefix}-legacy`,
        userId,
        providerId: "microsoft",
        issuer: null,
        accountId: "legacy-object-id",
      },
      {
        id: `${prefix}-other-provider`,
        userId,
        providerId: "other-provider",
        issuer,
        accountId: "other-provider-object-id",
      },
      {
        id: `${prefix}-other-issuer`,
        userId,
        providerId: "microsoft",
        issuer: `https://login.microsoftonline.com/other-tenant/v2.0`,
        accountId: "other-issuer-object-id",
      },
    ]);

    expect(await reader({ issuer, subject })).toEqual({
      userId,
      email,
      emailVerified: false,
      name: "Provisioned person",
    });
    for (const rejected of [
      "unknown-object-id",
      "legacy-object-id",
      "other-provider-object-id",
      "other-issuer-object-id",
      email,
    ])
      expect(await reader({ issuer, subject: rejected })).toBeNull();
    expect(
      await reader({
        issuer: issuer.replace(tenantId, "other-tenant"),
        subject,
      }),
    ).toBeNull();
    await expect(
      database
        .insert(accounts)
        .values({
          id: `${prefix}-duplicate-issuer`,
          userId,
          providerId: "other-provider",
          issuer,
          accountId: subject,
        })
        .execute(),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  test("removing the exact binding stops login while leaving local contact data intact", async () => {
    await database.delete(accounts).where(eq(accounts.id, `${prefix}-exact`));
    expect(await reader({ issuer, subject })).toBeNull();
    expect(
      await database
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId)),
    ).toHaveLength(1);
  });
});
