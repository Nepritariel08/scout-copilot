import { describe, expect, test } from "bun:test";
import { createAuth } from "../src/auth";
import type { AuthService } from "../src/auth/guards";
import type { OwnedDeploymentConfig } from "../src/config";
import type { Database } from "../src/db/client";
import { parseScoutMembership } from "../src/scout/membership";
import { createOwnedApplication } from "../src/scout/owned/application";
import { createOwnedAuthority } from "../src/scout/owned/authority";
import { createOwnedNativeIdentity } from "../src/scout/owned/native-identity";
import { createTenantScope } from "../src/scout/owned/scope";
import { startOwnedScout } from "../src/scout/owned/start";

const config = {
  runtime: { mode: "owned", durableHistory: true },
  databaseUrl: "postgres://synthetic.invalid/identity_pool_fixture",
  deploymentId: "pool-fixture",
  scoutMembershipsFile: "synthetic-memberships-not-read-by-this-fixture",
  scoutPlatformOwnerIds: [],
  singleUser: false,
  port: 0,
} as unknown as OwnedDeploymentConfig;
const membership = async (actor: { id: string }) =>
  parseScoutMembership(
    {
      version: 1,
      deploymentId: config.deploymentId,
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
          userId: "alice",
          tenantId: "tenant-a",
          revision: 1,
          policyRevision: 1,
          active: true,
          expiresAt: "2099-01-01T00:00:00Z",
        },
      ],
    },
    actor,
    config.deploymentId,
  );

/** Bounded synthetic SQL scheduling, not PostgreSQL or a replacement auth implementation. */
function boundedPool(max: number) {
  let active = 0,
    peak = 0,
    timeouts = 0,
    reads = 0,
    closes = 0;
  const waiting: Array<() => void> = [];
  async function use<T>(work: () => T | Promise<T>): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      const acquired = () => {
        clearTimeout(timer);
        active++;
        peak = Math.max(peak, active);
        resolve();
      };
      const timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(acquired), 1);
        timeouts++;
        reject(new Error("Synthetic bounded pool acquisition timeout"));
      }, 100);
      if (active < max) acquired();
      else waiting.push(acquired);
    });
    try {
      return await work();
    } finally {
      active--;
      waiting.shift()?.();
    }
  }
  const database = {
    $client: {
      close: async () => {
        expect(active).toBe(0);
        expect(waiting).toHaveLength(0);
        closes++;
      },
    },
    select: () => ({
      from: () => ({
        where: () =>
          use(() => {
            reads++;
            return [{ role: "user" }];
          }),
      }),
    }),
  } as unknown as Database;
  return {
    max,
    database,
    use,
    get stats() {
      return { active, peak, timeouts, reads, closes, waiting: waiting.length };
    },
  };
}

describe("owned identity connection isolation", () => {
  test("fresh native session and real role repository complete while every data connection is held", async () => {
    type Dependencies = Required<
      NonNullable<Parameters<typeof startOwnedScout>[0]>
    >;
    const pools: ReturnType<typeof boundedPool>[] = [];
    let authority!: ReturnType<typeof createOwnedAuthority>;
    let freshSessionReads = 0;
    const started = await startOwnedScout({
      loadOwnedConfig: () => config,
      createDatabase: (_url, options) => {
        if (!options?.max)
          throw new Error("Pool must have an explicit ceiling");
        const pool = boundedPool(options.max);
        pools.push(pool);
        return pool.database;
      },
      createOwnedApplication: async (_config, data, options) => {
        // The old startup supplied no identity port: reproduce its actual
        // composition with the data port, rather than hiding it behind a mock.
        const identity = options?.identityDatabase ?? data;
        const pool = pools.find((candidate) => candidate.database === identity);
        if (!pool) throw new Error("Unknown identity pool");
        const syntheticSessionIssuer: AuthService = {
          handler: () => new Response(null),
          api: {
            getSession: async ({ query }) => {
              expect(query?.disableCookieCache).toBe(true);
              return pool.use(() => {
                freshSessionReads++;
                return {
                  user: { id: "alice", email: "alice@fixture.invalid" },
                };
              });
            },
          },
        };
        const scope = createTenantScope({
          binding: membership,
          deploymentId: config.deploymentId,
        });
        const { auth, roles } = createOwnedNativeIdentity(
          config,
          identity,
          scope,
          syntheticSessionIssuer,
        );
        authority = createOwnedAuthority({
          auth,
          roles,
          binding: membership,
          profiles: { get: async () => null },
          channels: { get: async () => null },
        });
        return {
          productName: "Synthetic pool fixture",
          authority,
          channelEvents: {},
          close: async () => {},
        } as unknown as Awaited<
          ReturnType<Dependencies["createOwnedApplication"]>
        >;
      },
      startChannelActivityListener: async () => ({ stop: async () => {} }),
      createDemonstrationStore: () =>
        ({}) as ReturnType<Dependencies["createDemonstrationStore"]>,
      createDemonstrationRecorder: () =>
        ({}) as ReturnType<Dependencies["createDemonstrationRecorder"]>,
      startHttpServer: () => ({ addresses: ["no-listener"], stop: () => {} }),
    });
    try {
      const data = pools[0];
      if (!data) throw new Error("No data pool");
      let held = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Saturate the actual configured pool, including the old eight-slot
      // composition; assertions below separately pin the required new budget.
      const ceiling = data.max;
      const holders = Array.from({ length: ceiling }, () =>
        data.use(async () => {
          held++;
          await barrier;
        }),
      );
      while (held < ceiling) await Promise.resolve();
      const checked = await Promise.allSettled(
        Array.from({ length: ceiling }, async () => {
          const result = await authority.binding(
            new Request("http://fixture.invalid"),
          );
          expect(result.person.id).toBe("alice");
          expect(result.person.role).toBe("user");
          expect(result.policy.tenantId).toBe("tenant-a");
        }),
      );
      release();
      await Promise.all(holders);
      expect(checked.every((result) => result.status === "fulfilled")).toBe(
        true,
      );
      expect(pools).toHaveLength(2);
      expect(freshSessionReads).toBe(7);
      expect(pools[0]?.stats.peak).toBe(7);
      expect(pools[1]?.stats.peak).toBe(1);
      expect(pools[1]?.stats.reads).toBe(7);
      expect(pools.map((pool) => pool.stats.timeouts)).toEqual([0, 0]);
    } finally {
      await started.close();
    }
    expect(pools.map((pool) => pool.stats.closes)).toEqual([1, 1]);
  });

  test("production assembly refuses a missing or shared SQL identity pool before any database work", async () => {
    const data = boundedPool(1).database;
    for (const identityDatabase of [undefined, data, { ...data } as Database]) {
      await expect(
        createOwnedApplication(config, data, { identityDatabase }),
      ).rejects.toThrow("independent identity database pool");
    }
  });

  test("unsupported SCIM cannot be hidden by direct application or native-identity assembly", async () => {
    const previous = process.env.SCIM_BEARER_TOKEN;
    process.env.SCIM_BEARER_TOKEN = "synthetic-unsupported-owned-scim-token";
    const data = boundedPool(1).database;
    const identityDatabase = boundedPool(1).database;
    try {
      // These deliberately minimal DB ports cannot perform startup DB work.
      await expect(
        createOwnedApplication(config, data, { identityDatabase }),
      ).rejects.toThrow("unset SCIM_BEARER_TOKEN");
      expect(() =>
        createOwnedNativeIdentity(
          config,
          identityDatabase,
          createTenantScope({
            binding: membership,
            deploymentId: config.deploymentId,
          }),
        ),
      ).toThrow("unset SCIM_BEARER_TOKEN");
      // The unchanged generic/native factory still constructs SCIM for the
      // default composition. This refusal belongs only to owned assembly.
      const defaultAuth = createAuth(
        {
          auth: {
            baseUrl: "http://127.0.0.1:3000",
            secret: "synthetic-default-auth-secret-for-scim-fixture",
            trustedOrigins: [],
            initialAdminEmails: [],
            allowedEmailDomains: [],
            google: {
              clientId: "synthetic-id",
              clientSecret: "synthetic-secret",
            },
          },
          keyEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
        } as unknown as Parameters<typeof createAuth>[0],
        identityDatabase,
      );
      expect(
        defaultAuth.options.plugins?.some((plugin) => plugin.id === "scim"),
      ).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.SCIM_BEARER_TOKEN;
      else process.env.SCIM_BEARER_TOKEN = previous;
    }
  });
});
