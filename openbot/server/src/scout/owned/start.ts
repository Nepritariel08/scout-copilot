import { loadOwnedConfig } from "../../config";
import { createDatabase } from "../../db/client";
import { createDemonstrationRecorder } from "../../demonstrations/recording";
import { createDemonstrationStore } from "../../demonstrations/store";
import { startHttpServer } from "../../http-server";
import { createOwnedApplication } from "./application";

export async function startOwnedScout() {
  const config = loadOwnedConfig();
  const database = createDatabase(config.databaseUrl);
  let owned: Awaited<ReturnType<typeof createOwnedApplication>>;
  try {
    owned = await createOwnedApplication(config, database);
  } catch (error) {
    await database.$client.close();
    throw error;
  }
  const demonstrationStore = createDemonstrationStore(database);
  const demonstrationRecorder = createDemonstrationRecorder({
    store: demonstrationStore,
    ownsBot: async (userId, botId) =>
      Boolean(await owned.profiles.get({ id: userId, role: "user" }, botId)),
    ownsSkill: async () => false,
  });
  let listener: ReturnType<typeof startHttpServer>;
  try {
    listener = startHttpServer({
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
  } catch (error) {
    await owned.close();
    await database.$client.close();
    throw error;
  }
  let stopping: Promise<void> | undefined;
  const close = () =>
    (stopping ??= (async () => {
      listener.stop();
      await owned.close();
      await database.$client.close();
    })());
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      void close().then(() => process.exit(0));
    });
  console.info(
    `${owned.productName} owned server listening on ${listener.addresses.join(" and ")}`,
  );
  return { ...owned, listener, close };
}
