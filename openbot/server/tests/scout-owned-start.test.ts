import { describe, expect, test } from "bun:test";
import { startOwnedScout } from "../src/scout/owned/start";

type Dependencies = Required<
  NonNullable<Parameters<typeof startOwnedScout>[0]>
>;

function fixture(
  options: {
    applicationFailure?: Error;
    identityDatabaseCreationFailure?: Error;
    sharedIdentityClient?: boolean;
    activityFailure?: Error;
    demonstrationFailure?: Error;
    httpFailure?: Error;
    stopHttpFailure?: Error;
    stopActivityFailure?: Error;
    closeHistoryFailure?: Error;
    closeDatabaseFailure?: Error;
    closeIdentityDatabaseFailure?: Error;
    historyBarrier?: Promise<void>;
  } = {},
) {
  const events: string[] = [];
  const databaseCreationCalls: Array<{
    databaseUrl: string;
    options?: { max?: number };
  }> = [];
  const database = {
    $client: {
      async close() {
        events.push("database.close");
        if (options.closeDatabaseFailure) throw options.closeDatabaseFailure;
      },
    },
  } as unknown as ReturnType<Dependencies["createDatabase"]>;
  const identityDatabase = {
    $client: {
      async close() {
        events.push("identityDatabase.close");
        if (options.closeIdentityDatabaseFailure)
          throw options.closeIdentityDatabaseFailure;
      },
    },
  } as unknown as ReturnType<Dependencies["createDatabase"]>;
  const owned = {
    productName: "Synthetic owned lifecycle fixture",
    channelEvents: {},
    profiles: {},
    authority: {},
    app: {},
    async close() {
      events.push("history.close.start");
      await options.historyBarrier;
      events.push("history.close.end");
      if (options.closeHistoryFailure) throw options.closeHistoryFailure;
    },
  } as unknown as Awaited<ReturnType<Dependencies["createOwnedApplication"]>>;
  const deps: Dependencies = {
    loadOwnedConfig: () =>
      ({
        databaseUrl: "postgres://synthetic.invalid/lifecycle_test",
        port: 0,
      }) as ReturnType<Dependencies["loadOwnedConfig"]>,
    createDatabase(databaseUrl, poolOptions) {
      databaseCreationCalls.push({ databaseUrl, options: poolOptions });
      if (databaseCreationCalls.length === 1) return database;
      if (options.identityDatabaseCreationFailure)
        throw options.identityDatabaseCreationFailure;
      if (options.sharedIdentityClient)
        return { ...database } as typeof database;
      return identityDatabase;
    },
    async createOwnedApplication(_config, data, identityOptions) {
      expect(data).toBe(database);
      expect(identityOptions?.identityDatabase).toBe(identityDatabase);
      expect(data.$client).not.toBe(identityOptions?.identityDatabase?.$client);
      events.push("application.start");
      if (options.applicationFailure) throw options.applicationFailure;
      return owned;
    },
    async startChannelActivityListener() {
      events.push("activity.start");
      if (options.activityFailure) throw options.activityFailure;
      return {
        async stop() {
          events.push("activity.stop");
          if (options.stopActivityFailure) throw options.stopActivityFailure;
        },
      };
    },
    createDemonstrationStore() {
      events.push("demonstrations.create");
      if (options.demonstrationFailure) throw options.demonstrationFailure;
      return {} as ReturnType<Dependencies["createDemonstrationStore"]>;
    },
    createDemonstrationRecorder: () =>
      ({}) as ReturnType<Dependencies["createDemonstrationRecorder"]>,
    startHttpServer() {
      events.push("http.start");
      if (options.httpFailure) throw options.httpFailure;
      return {
        addresses: ["synthetic-no-listener"],
        stop() {
          events.push("http.stop");
          if (options.stopHttpFailure) throw options.stopHttpFailure;
        },
      };
    },
  };
  return { deps, events, databaseCreationCalls };
}

describe("owned startup resource lifecycle", () => {
  test("unsupported SCIM configuration is refused before acquiring clients or starting the application", async () => {
    const previous = process.env.SCIM_BEARER_TOKEN;
    process.env.SCIM_BEARER_TOKEN = "synthetic-unsupported-owned-scim-token";
    try {
      const { deps, events, databaseCreationCalls } = fixture();
      await expect(startOwnedScout(deps)).rejects.toThrow(
        "unset SCIM_BEARER_TOKEN",
      );
      expect(databaseCreationCalls).toEqual([]);
      expect(events).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.SCIM_BEARER_TOKEN;
      else process.env.SCIM_BEARER_TOKEN = previous;
    }
  });

  test("bounds the owned application query pool within the pilot connection budget", async () => {
    const { deps, databaseCreationCalls } = fixture();
    const started = await startOwnedScout(deps);
    expect(databaseCreationCalls).toEqual([
      {
        databaseUrl: "postgres://synthetic.invalid/lifecycle_test",
        options: { max: 7 },
      },
      {
        databaseUrl: "postgres://synthetic.invalid/lifecycle_test",
        options: { max: 1 },
      },
    ]);
    await started.close();
  });

  test("preserves the application startup error when database cleanup also fails", async () => {
    const original = new Error("synthetic application startup failure");
    const { deps, events } = fixture({
      applicationFailure: original,
      closeDatabaseFailure: new Error("synthetic database cleanup failure"),
    });
    await expect(startOwnedScout(deps)).rejects.toBe(original);
    expect(events).toEqual([
      "application.start",
      "identityDatabase.close",
      "database.close",
    ]);
  });

  test("identity pool construction failure closes only the acquired data pool and preserves the failure", async () => {
    const original = new Error("synthetic identity pool construction failure");
    const { deps, events } = fixture({
      identityDatabaseCreationFailure: original,
      closeDatabaseFailure: new Error("synthetic data close failure"),
    });
    await expect(startOwnedScout(deps)).rejects.toBe(original);
    expect(events).toEqual(["database.close"]);
  });

  test("refuses two wrappers sharing one SQL client before application work and closes that client once", async () => {
    const { deps, events } = fixture({ sharedIdentityClient: true });
    await expect(startOwnedScout(deps)).rejects.toThrow(
      "independent identity database pool",
    );
    expect(events).toEqual(["database.close"]);
  });

  test("identity close failure still closes data and is reported once after consumers stop", async () => {
    const original = new Error("synthetic identity close failure");
    const { deps, events } = fixture({
      closeIdentityDatabaseFailure: original,
    });
    const started = await startOwnedScout(deps);
    await expect(started.close()).rejects.toBe(original);
    await expect(started.close()).rejects.toBe(original);
    expect(events.slice(-3)).toEqual([
      "history.close.end",
      "identityDatabase.close",
      "database.close",
    ]);
    expect(
      events.filter((event) => event === "identityDatabase.close"),
    ).toHaveLength(1);
    expect(events.filter((event) => event === "database.close")).toHaveLength(
      1,
    );
  });

  test("waits for history cleanup before closing its database after LISTEN startup fails", async () => {
    const original = new Error("synthetic LISTEN startup failure");
    let finishHistory!: () => void;
    const barrier = new Promise<void>((resolve) => {
      finishHistory = resolve;
    });
    const { deps, events } = fixture({
      activityFailure: original,
      historyBarrier: barrier,
    });
    const started = startOwnedScout(deps);
    // Catch immediately while cleanup is deliberately paused, avoiding an unhandled rejection.
    const result = started.then(
      () => null,
      (error: unknown) => error,
    );
    for (
      let turn = 0;
      turn < 10 && !events.includes("history.close.start");
      turn++
    )
      await Promise.resolve();
    expect(events).toEqual([
      "application.start",
      "activity.start",
      "history.close.start",
    ]);
    finishHistory();
    expect(await result).toBe(original);
    expect(events).toEqual([
      "application.start",
      "activity.start",
      "history.close.start",
      "history.close.end",
      "identityDatabase.close",
      "database.close",
    ]);
  });

  test("a constructor failure after LISTEN acquisition also closes LISTEN and history before the database", async () => {
    const original = new Error("synthetic recorder setup failure");
    const { deps, events } = fixture({ demonstrationFailure: original });
    await expect(startOwnedScout(deps)).rejects.toBe(original);
    expect(events).toEqual([
      "application.start",
      "activity.start",
      "demonstrations.create",
      "activity.stop",
      "history.close.start",
      "history.close.end",
      "identityDatabase.close",
      "database.close",
    ]);
  });

  test("HTTP startup failure attempts every acquired cleanup despite their errors and retains the original failure", async () => {
    const original = new Error("synthetic HTTP bind failure");
    const { deps, events } = fixture({
      httpFailure: original,
      stopActivityFailure: new Error("synthetic LISTEN stop failure"),
      closeHistoryFailure: new Error("synthetic history stop failure"),
      closeDatabaseFailure: new Error("synthetic database close failure"),
    });
    await expect(startOwnedScout(deps)).rejects.toBe(original);
    expect(events).toEqual([
      "application.start",
      "activity.start",
      "demonstrations.create",
      "http.start",
      "activity.stop",
      "history.close.start",
      "history.close.end",
      "identityDatabase.close",
      "database.close",
    ]);
  });

  test("shutdown remains idempotent and closes the database after synchronous HTTP stop and other cleanup failures", async () => {
    const original = new Error("synthetic synchronous HTTP stop failure");
    const { deps, events } = fixture({
      stopHttpFailure: original,
      stopActivityFailure: new Error("synthetic LISTEN stop failure"),
      closeHistoryFailure: new Error("synthetic history stop failure"),
      closeDatabaseFailure: new Error("synthetic database close failure"),
      closeIdentityDatabaseFailure: new Error(
        "synthetic identity close failure",
      ),
    });
    const beforeTerm = process.listenerCount("SIGTERM");
    const beforeInt = process.listenerCount("SIGINT");
    const started = await startOwnedScout(deps);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);
    const first = started.close();
    const second = started.close();
    expect(second).toBe(first);
    await expect(first).rejects.toBe(original);
    await expect(second).rejects.toBe(original);
    expect(events.slice(-6)).toEqual([
      "http.stop",
      "activity.stop",
      "history.close.start",
      "history.close.end",
      "identityDatabase.close",
      "database.close",
    ]);
    expect(events.filter((event) => event === "database.close")).toHaveLength(
      1,
    );
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
  });

  test("reports a database-only close failure after stopping the other resources", async () => {
    const original = new Error("synthetic database-only close failure");
    const { deps, events } = fixture({ closeDatabaseFailure: original });
    const started = await startOwnedScout(deps);
    await expect(started.close()).rejects.toBe(original);
    await expect(started.close()).rejects.toBe(original);
    expect(events.slice(-6)).toEqual([
      "http.stop",
      "activity.stop",
      "history.close.start",
      "history.close.end",
      "identityDatabase.close",
      "database.close",
    ]);
    expect(events.filter((event) => event === "database.close")).toHaveLength(
      1,
    );
  });
  test("normal shutdown closes resources once in dependency order and removes its signal handlers", async () => {
    const { deps, events } = fixture();
    const beforeTerm = process.listenerCount("SIGTERM");
    const beforeInt = process.listenerCount("SIGINT");
    const started = await startOwnedScout(deps);
    await started.close();
    await started.close();
    expect(events.slice(-6)).toEqual([
      "http.stop",
      "activity.stop",
      "history.close.start",
      "history.close.end",
      "identityDatabase.close",
      "database.close",
    ]);
    expect(events.filter((event) => event === "database.close")).toHaveLength(
      1,
    );
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
  });
});
