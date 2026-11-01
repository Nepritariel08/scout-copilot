import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createScoutAuth0AccountReader } from "../src/auth/scout-auth0";
import { createDatabase } from "../src/db/client";
import { accounts, users } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `scout-auth0-accounts-${randomUUID()}`;
const userId = `${prefix}-native-owner`;
const issuer = "https://identity.auth0.fixture.example/";
const email = `${prefix}@fixture.example`;
const subject = `${prefix}-subject`;
const reader = createScoutAuth0AccountReader(database);

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

describe("Auth0 operator-provisioned native account lookup", () => {
  test("requires exact provider, issuer and immutable subject, never merely the same email", async () => {
    await database
      .insert(users)
      .values({ id: userId, email, emailVerified: true });
    await database.insert(accounts).values([
      {
        id: `${prefix}-exact`,
        userId,
        providerId: "auth0",
        issuer,
        accountId: subject,
      },
      {
        id: `${prefix}-legacy`,
        userId,
        providerId: "auth0",
        issuer: null,
        accountId: `${subject}-legacy`,
      },
      {
        id: `${prefix}-other-provider`,
        userId,
        providerId: "other-provider",
        issuer,
        accountId: `${subject}-other-provider`,
      },
      {
        id: `${prefix}-other-issuer`,
        userId,
        providerId: "auth0",
        issuer: "https://other.auth0.fixture.example/",
        accountId: `${subject}-other-issuer`,
      },
    ]);
    expect(await reader({ issuer, subject })).toEqual({ userId, email });
    for (const rejected of [
      "unknown-subject",
      `${subject}-legacy`,
      `${subject}-other-provider`,
      `${subject}-other-issuer`,
      email,
    ])
      expect(await reader({ issuer, subject: rejected })).toBeNull();
    expect(await reader({ issuer: issuer.slice(0, -1), subject })).toBeNull();
    expect(
      await reader({ issuer: "https://other.auth0.fixture.example/", subject }),
    ).toBeNull();
  });

  test("a removed mapping immediately stops resolving while the same native email remains", async () => {
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
