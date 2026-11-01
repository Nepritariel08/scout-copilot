import type { AbstractAgent } from "@ag-ui/client";
import { UnavailableAgent } from "@openbot/toolkit/copilotkit/agents";
import { and, eq, isNotNull } from "drizzle-orm";
import { createAgentProfileStore } from "../../agents/profile-store";
import { createRuntimeAgentLoader } from "../../agents/runtime-agents";
import { createApp } from "../../app";
import { createAuditReader, createAuditStore } from "../../audit";
import { createAuth } from "../../auth";
import {
  type AuthenticatedActor,
  type AuthService,
  createRoleRepository,
} from "../../auth/guards";
import { createIdentityProviderStore } from "../../auth/identity-provider-store";
import { createOrganizationAuth } from "../../auth/organization";
import { organizationUserStore } from "../../auth/organization-store";
import { createChannelEventHub } from "../../channels/events";
import { createChannelStore } from "../../channels/routes";
import { createThreadIdentity } from "../../channels/thread-identity";
import type { OwnedDeploymentConfig } from "../../config";
import {
  createCredentialAdminService,
  createCredentialStore,
} from "../../credentials";
import type { Database } from "../../db/client";
import {
  channelMemberships,
  channels as nativeChannels,
} from "../../db/schema/core";
import { createDuetChannelStore } from "../../openduet/channels";
import { createPageStore } from "../../openduet/pages";
import { createOnboardingStore } from "../../people/onboarding";
import { createPeopleStore } from "../../people/store";
import {
  createPackageStatusReader,
  loadTenantPackage,
  synchronizeTenantPackage,
} from "../../tenant-package";
import { createUserInstructionsStore } from "../../user-instructions";
import { createUserPreferencesStore } from "../../user-preferences";
import { createScoutBindingReader } from "../binding";
import { createHistoryEngine } from "../history/runner";
import { createBoundHistory } from "../history/service";
import { createHistoryStore } from "../history/store";
import { createScoutConnector } from "../mcp";
import { createOwnedModelAgents } from "../owned-model/agents";
import { createModelCallStore } from "../owned-model/store";
import { createScoutService } from "../service";
import { createScoutStore } from "../store";
import { ScoutError } from "../types";
import { createOwnedIdentity } from "./auth";
import { type BindingReader, createOwnedAuthority } from "./authority";
import { createOwnedRuntimeRoutes } from "./routes";
import { createTenantScope } from "./scope";

/** The existing Scout app with an owned composition; no vendor client or background work scheduler. */
export async function createOwnedApplication(
  config: OwnedDeploymentConfig,
  database: Database,
  options: {
    /** Trusted test issuer seam; production constructs the configured native authentication service. */
    auth?: AuthService;
    binding?: BindingReader;
    agents?: (
      actor: AuthenticatedActor,
      request: Request,
    ) => Promise<Record<string, AbstractAgent>>;
    /** Trusted synthetic provider seam; absent in the production entry. */
    modelFetch?: typeof fetch;
  } = {},
) {
  if (
    config.runtime.mode !== "owned" ||
    config.singleUser ||
    !config.scoutQueueBindingsFile
  )
    throw new Error(
      "Owned Scout requires its explicit configuration and verified sign-in.",
    );
  const audit = createAuditStore(database);
  const credentials = createCredentialStore(database);
  const tenantPackage = await loadTenantPackage(config.tenantPackageDirectory);
  await synchronizeTenantPackage(database, tenantPackage);
  const nativeBinding =
    options.binding ?? createScoutBindingReader(config.scoutQueueBindingsFile);
  const deploymentId = config.deploymentId ?? tenantPackage.tenantId;
  const binding: BindingReader = async (actor) => {
    const policy = await nativeBinding(actor);
    if (
      policy.userId !== actor.id ||
      policy.deploymentId !== deploymentId ||
      !policy.tenantId ||
      !policy.fingerprint
    )
      throw new ScoutError("SCOUT_ACCESS_DENIED", 403);
    return policy;
  };
  const scope = createTenantScope({
    binding,
    deploymentId,
  });
  await database.transaction((tx) =>
    scope.seedTemplates(
      tx,
      tenantPackage.tenantId,
      tenantPackage.agents.map((agent) => agent.id),
    ),
  );
  const profiles = createAgentProfileStore(
    database,
    undefined,
    {
      store: credentials,
      encryptionKey: config.keyEncryptionKey,
    },
    scope,
  );
  const people = createPeopleStore(
    database,
    config.auth?.initialAdminEmails ?? [],
  );
  const nativeAuth =
    options.auth ??
    (config.organizationAuthUrl
      ? createOrganizationAuth({
          authorityUrl: config.organizationAuthUrl,
          materializeUser: async (user) => {
            if (await people.isRevoked(user.email))
              throw new Error("SCOUT_ACCESS_DENIED");
            return organizationUserStore(database, {
              requireSubjectMatch: true,
            })(user);
          },
        })
      : createAuth(
          config,
          database,
          (email) => people.isRevoked(email),
          audit,
        ));
  const { auth, roles } = createOwnedIdentity({
    auth: nativeAuth,
    roles: createRoleRepository(database),
    scope,
    platformOwnerIds: config.scoutPlatformOwnerIds,
  });
  const historyStore = createHistoryStore(database);
  const historyEngine = createHistoryEngine(historyStore);
  const threadIdentity = createThreadIdentity(
    config.deploymentId ?? tenantPackage.tenantId,
  );
  const channels = createChannelStore(
    database,
    profiles,
    threadIdentity,
    async (transaction, input) => {
      const policy = await binding(input.actor);
      const agentId = input.agentIds[0];
      if (!agentId) throw new Error("A conversation requires an agent.");
      await historyStore.mintForChannel(
        transaction,
        { userId: input.actor.id, tenantId: policy.tenantId },
        {
          id: input.threadId,
          channelId: input.channelId,
          agentId,
        },
      );
      const current = await binding(input.actor);
      if (current.fingerprint !== policy.fingerprint)
        throw new Error("SCOUT_ACCESS_DENIED");
    },
    scope,
  );
  const authority = createOwnedAuthority({
    auth,
    roles,
    binding,
    profiles,
    channels,
  });
  const loadAgents = createRuntimeAgentLoader(
    database,
    undefined,
    undefined,
    scope,
  );
  const modelCalls = createModelCallStore(database);
  const agents =
    options.agents ??
    (config.scoutModelPolicyFile
      ? createOwnedModelAgents({
          database,
          policyFile: config.scoutModelPolicyFile,
          authority,
          history: historyStore,
          calls: modelCalls,
          transport: options.modelFetch,
          scope,
        })
      : async (actor: AuthenticatedActor) =>
          Object.fromEntries(
            (await loadAgents(actor)).map((agent) => [
              agent.id,
              new UnavailableAgent({
                id: agent.id,
                name: agent.name,
                reason:
                  "The model route for this deployment has not been configured yet.",
              }),
            ]),
          ));
  const handler = createOwnedRuntimeRoutes({
    authority,
    engine: historyEngine,
    agents,
    generativeUi: config.generativeUi,
    modelReceipts: async (request, threadId) => {
      const thread = await createBoundHistory(
        historyStore,
        authority.forRequest(request),
      ).get(threadId);
      const { person, policy } = await authority.binding(request);
      const receipts = await modelCalls.receipts(
        {
          userId: person.id,
          tenantId: policy.tenantId,
          deploymentId: policy.deploymentId,
          agentId: thread.agentId,
        },
        threadId,
      );
      await createBoundHistory(
        historyStore,
        authority.forRequest(request),
      ).check(threadId, "read", thread.agentId);
      return receipts;
    },
  });
  const scout = createScoutService({
    store: createScoutStore(database),
    binding,
    canReadChannel: async (actor, channelId) =>
      Boolean(await channels.get({ id: actor.id, role: "user" }, channelId)),
    connect: createScoutConnector(),
  });
  const pages = createPageStore(database, {
    scope,
    actorForRequest: authority.actor,
  });
  const duetChannels = createDuetChannelStore({ database, channels, scope });
  const channelEvents = createChannelEventHub(async (userId, request) => {
    if (!request || (await authority.actor(request)).id !== userId)
      throw new ScoutError("SCOUT_ACCESS_DENIED", 403);
    const principal = await scope.resolve(userId);
    return async (event) => {
      if ((await authority.actor(request)).id !== userId) return false;
      await scope.assertCurrent(principal);
      if ("resync" in event) return true;
      // Deleted channels are intentionally absent from get(); their current members still need
      // the tombstone to remove them from an open roster. Keep this narrowly scoped SQL grant.
      const allowed = event.deleted
        ? Boolean(
            (
              await database
                .select({ id: nativeChannels.id })
                .from(nativeChannels)
                .innerJoin(
                  channelMemberships,
                  and(
                    eq(channelMemberships.channelId, nativeChannels.id),
                    eq(channelMemberships.userId, userId),
                  ),
                )
                .where(
                  and(
                    eq(nativeChannels.id, event.channelId),
                    isNotNull(nativeChannels.deletedAt),
                    scope.predicate(principal, "channel", nativeChannels.id),
                  ),
                )
                .limit(1)
            )[0],
          )
        : Boolean(
            await channels.get({ id: userId, role: "user" }, event.channelId),
          );
      if ((await authority.actor(request)).id !== userId) return false;
      await scope.assertCurrent(principal);
      return allowed;
    };
  });
  const app = createApp(
    config,
    auth,
    roles,
    createAuditReader(database),
    createCredentialAdminService(config.keyEncryptionKey, credentials, audit),
    createPackageStatusReader(database),
    handler,
    undefined,
    undefined,
    profiles,
    channels,
    channelEvents,
    audit,
    undefined,
    undefined,
    undefined,
    undefined,
    people,
    createIdentityProviderStore(database),
    undefined,
    undefined,
    undefined,
    undefined,
    createOnboardingStore(database),
    createUserInstructionsStore(database, scope),
    database,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createUserPreferencesStore(database),
    undefined,
    undefined,
    {
      scout,
      scoutOwned: {
        requireTenant: authority.requireTenant,
        scope,
        requirePlatformAdmin: async (request) => {
          const { person } = await authority.binding(request);
          if (
            person.role !== "admin" ||
            !config.scoutPlatformOwnerIds.includes(person.id)
          )
            throw new ScoutError("SCOUT_ACCESS_DENIED", 403);
        },
      },
      openduet: { pages, channels: duetChannels },
    },
  );
  return {
    app,
    authority,
    profiles,
    scope,
    channelEvents,
    channels,
    historyStore,
    historyEngine,
    modelCalls,
    productName: tenantPackage.productName,
    close: () => historyEngine.close(),
  };
}
