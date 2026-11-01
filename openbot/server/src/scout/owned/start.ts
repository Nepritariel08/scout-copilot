import { startChannelActivityListener } from "../../channels/events";
import { loadOwnedConfig } from "../../config";
import { createDatabase } from "../../db/client";
import { createDemonstrationRecorder } from "../../demonstrations/recording";
import { createDemonstrationStore } from "../../demonstrations/store";
import { startHttpServer } from "../../http-server";
import { createOwnedApplication } from "./application";

// Keep the one-process pilot below its 24-connection role cap; LISTEN owns a
// separate max: 1 client and is counted independently.
const ownedApplicationDatabasePoolMax = 8;

type OwnedStartupDependencies = {
  loadOwnedConfig: typeof loadOwnedConfig;
  createDatabase: typeof createDatabase;
  createOwnedApplication: typeof createOwnedApplication;
  startChannelActivityListener: typeof startChannelActivityListener;
  createDemonstrationStore: typeof createDemonstrationStore;
  createDemonstrationRecorder: typeof createDemonstrationRecorder;
  startHttpServer: typeof startHttpServer;
};

/** Dependency overrides are a trusted lifecycle-test seam; the production entry passes none. */
export async function startOwnedScout(
  overrides: Partial<OwnedStartupDependencies> = {},
) {
  const deps = {
    loadOwnedConfig,
    createDatabase,
    createOwnedApplication,
    startChannelActivityListener,
    createDemonstrationStore,
    createDemonstrationRecorder,
    startHttpServer,
    ...overrides,
  };
  const config = deps.loadOwnedConfig();
  const database = deps.createDatabase(config.databaseUrl, {
    max: ownedApplicationDatabasePoolMax,
  });
  const cleanup: (() => unknown | Promise<unknown>)[] = [];
  let stopping: Promise<void> | undefined;
  let signalsRegistered = false;
  const close = (): Promise<void> =>
    (stopping ??= (async () => {
      if (signalsRegistered) {
        for (const signal of ["SIGTERM", "SIGINT"] as const)
          process.removeListener(signal, stopOnSignal);
        signalsRegistered = false;
      }
      let failed = false;
      let failure: unknown;
      // Reverse acquisition order: stop HTTP, LISTEN and history while their database is still open.
      // Call each inside the try, so synchronous throws cannot prevent later cleanup either.
      for (const stop of [...cleanup]
        .reverse()
        .concat([() => database.$client.close()])) {
        try {
          await stop();
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
      if (failed) throw failure;
    })());
  const stopOnSignal = () => {
    void close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  let owned: Awaited<ReturnType<typeof createOwnedApplication>>;
  let activity: Awaited<ReturnType<typeof startChannelActivityListener>>;
  let listener: ReturnType<typeof startHttpServer>;
  try {
    owned = await deps.createOwnedApplication(config, database);
    cleanup.push(() => owned.close());
    activity = await deps.startChannelActivityListener(
      config.databaseUrl,
      owned.channelEvents,
    );
    cleanup.push(() => activity.stop());
    const demonstrationStore = deps.createDemonstrationStore(database);
    const demonstrationRecorder = deps.createDemonstrationRecorder({
      store: demonstrationStore,
      ownsBot: async (userId, botId) =>
        Boolean(await owned.profiles.get({ id: userId, role: "user" }, botId)),
      ownsSkill: async () => false,
    });
    listener = deps.startHttpServer({
      port: config.port,
      config,
      resolveRequestActor: async (request) => {
        const { person } = await owned.authority.binding(request);
        return {
          id: person.id,
          name: person.name ?? person.email,
          role: person.role,
        };
      },
      agentProfileStore: owned.profiles,
      computerGateway: undefined,
      demonstrationStore,
      demonstrationRecorder,
      app: owned.app,
    });
    cleanup.push(() => listener.stop());
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, stopOnSignal);
  signalsRegistered = true;
  console.info(
    `${owned.productName} owned server listening on ${listener.addresses.join(" and ")}`,
  );
  return { ...owned, listener, close };
}
