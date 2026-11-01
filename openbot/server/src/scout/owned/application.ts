import type { AbstractAgent } from "@ag-ui/client";
import { UnavailableAgent } from "@openbot/toolkit/copilotkit/agents";
import { and, eq, isNotNull } from "drizzle-orm";
import { createAgentProfileStore } from "../../agents/profile-store";
import { createRuntimeAgentLoader } from "../../agents/runtime-agents";
import { createApp } from "../../app";
import { createAuditReader, createAuditStore } from "../../audit";
import type { AuthenticatedActor, AuthService } from "../../auth/guards";
import { createIdentityProviderStore } from "../../auth/identity-provider-store";
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
import { createHistoryContextStore } from "../history/context-store";
import { createHistoryEngine } from "../history/runner";
import type { HistoryResource } from "../history/service";
import { createBoundHistory } from "../history/service";
import { createHistoryStore } from "../history/store";
import { createScoutConnector } from "../mcp";
import {
  createScoutMembershipReader,
  type MembershipReader,
} from "../membership";
import { createOwnedModelAgents } from "../owned-model/agents";
import {
  type ContextHistory,
  createContextHistory,
} from "../owned-model/context-history";
import {
  createOwnedOdooContextAdapters,
  readOwnedOdooContextSource,
} from "../owned-model/context-source";
import { createOwnedOdooGrantService } from "../owned-model/grant-service";
import {
  bindOwnedOdooContext,
  createOwnedOdooAdmission,
  createOwnedOdooBindingReader,
} from "../owned-model/odoo-binding";
import { createModelPolicyReader } from "../owned-model/policy";
import type { ProjectTaskContextPort } from "../owned-model/record-context";
import { createModelCallStore } from "../owned-model/store";
import { createScoutService } from "../service";
import { createScoutStore } from "../store";
import { ScoutError } from "../types";
import { createOwnedAuthority } from "./authority";
import {
  assertOwnedNativeIdentityConfiguration,
  createOwnedNativeIdentity,
} from "./native-identity";
import { createOwnedQueueBindingReader } from "./queue-binding";
import { createOwnedRuntimeRoutes } from "./routes";
import { createTenantScope } from "./scope";

/** The existing Scout app with an owned composition; no vendor client or background work scheduler. */
export async function createOwnedApplication(
  config: OwnedDeploymentConfig,
  database: Database,
  options: {
    /** Independent bounded pool for native auth and every identity callback. */
    identityDatabase?: Database;
    /** Trusted test issuer seam; production constructs the configured native authentication service. */
    auth?: AuthService;
    membership?: MembershipReader;
    agents?: (
      actor: AuthenticatedActor,
      request: Request,
    ) => Promise<Record<string, AbstractAgent>>;
    /** Trusted synthetic provider seam; absent in the production entry. */
    modelFetch?: typeof fetch;
    /** Test-only transport seam for the fixed JSON-2 reader. */
    odooFetch?: typeof fetch;
    /** Test-only record reader override. */
    recordContext?: ProjectTaskContextPort;
  } = {},
) {
  if (
    config.runtime.mode !== "owned" ||
    config.singleUser ||
    typeof config.deploymentId !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(config.deploymentId) ||
    !config.scoutMembershipsFile ||
    (config.scoutDelegatedDraftsEnabled && !config.scoutQueueBindingsFile)
  )
    throw new Error(
      "Owned Scout requires its explicit configuration and verified sign-in.",
    );
  assertOwnedNativeIdentityConfiguration();
  // Never allow production auth to wait for the data transaction that requested
  // its fresh check. Distinct Drizzle wrappers around one SQL client still share
  // a pool. Only the explicit synthetic issuer seam may omit a separate pool.
  if (
    (!options.auth && !options.identityDatabase) ||
    (options.identityDatabase &&
      (options.identityDatabase === database ||
        options.identityDatabase.$client === database.$client))
  )
    throw new Error(
      "Owned Scout requires an independent identity database pool.",
    );
  const identityDatabase = options.identityDatabase ?? database;
  const audit = createAuditStore(database);
  const credentials = createCredentialStore(database);
  const tenantPackage = await loadTenantPackage(config.tenantPackageDirectory);
  await synchronizeTenantPackage(database, tenantPackage);
  const deploymentId = config.deploymentId;
  const nativeBinding =
    options.membership ??
    createScoutMembershipReader(config.scoutMembershipsFile, deploymentId);
  const binding: MembershipReader = async (actor) => {
    const policy = await nativeBinding(actor);
    if (
      policy.userId !== actor.id ||
      policy.deploymentId !== deploymentId ||
      !policy.tenantId ||
      !policy.fingerprint ||
      !(Date.parse(policy.expiresAt) > Date.now())
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
  const { auth, roles } = createOwnedNativeIdentity(
    config,
    identityDatabase,
    scope,
    options.auth,
  );
  const historyStore = createHistoryStore(database);
  const historyContextStore = createHistoryContextStore(database);
  let contextHistory: ContextHistory | undefined;
  let authorizeHistoryContext: (
    request: Request,
    resource: HistoryResource,
  ) => Promise<void> = async () => {
    throw new Error("HISTORY_ACCESS_DENIED");
  };
  const historyEngine = createHistoryEngine(historyStore);
  const threadIdentity = createThreadIdentity(deploymentId);
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
    authorizeContext: (request, resource) =>
      authorizeHistoryContext(request, resource),
  });
  const loadAgents = createRuntimeAgentLoader(
    database,
    undefined,
    undefined,
    scope,
  );
  const modelCalls = createModelCallStore(database);
  const odooContextSource = config.scoutOdooContextSourceFile
    ? await readOwnedOdooContextSource(config.scoutOdooContextSourceFile)
    : undefined;
  const odooContextAdapters = odooContextSource
    ? createOwnedOdooContextAdapters(
        database,
        config.keyEncryptionKey,
        odooContextSource,
        options.odooFetch,
      )
    : undefined;
  const odooAdmission =
    odooContextSource && config.scoutOdooBindingsFile
      ? createOwnedOdooAdmission({
          membership: binding,
          binding: createOwnedOdooBindingReader(
            config.scoutOdooBindingsFile,
            odooContextSource.sourceInstanceId,
          ),
          sourceInstanceId: odooContextSource.sourceInstanceId,
        })
      : undefined;
  const underlyingRecordContext =
    options.recordContext ?? odooContextAdapters?.recordContext;
  const recordContext =
    underlyingRecordContext && odooAdmission
      ? bindOwnedOdooContext(underlyingRecordContext, odooAdmission)
      : !odooContextSource
        ? options.recordContext // Explicit synthetic test seam only; production supplies no options.
        : undefined; // A configured source cannot bypass missing Odoo admission via an override.
  const odooGrantService = odooContextSource
    ? createOwnedOdooGrantService(
        database,
        config.keyEncryptionKey,
        odooContextSource.sourceInstanceId,
      )
    : undefined;
  const readOdooModelPolicy = config.scoutModelPolicyFile
    ? createModelPolicyReader(config.scoutModelPolicyFile)
    : undefined;
  contextHistory = createContextHistory({
    store: historyContextStore,
    recordContext,
    ...(readOdooModelPolicy
      ? {
          readPolicy: (principal, agentId) =>
            readOdooModelPolicy({
              userId: principal.userId,
              tenantId: principal.tenantId,
              deploymentId: principal.deploymentId,
              agentId,
            }),
        }
      : {}),
  });
  authorizeHistoryContext = async (request, resource) => {
    if (!resource.id || !contextHistory)
      throw new Error("HISTORY_ACCESS_DENIED");
    const { person, policy: current } = await authority.binding(request);
    await contextHistory.assertCurrent(
      {
        userId: person.id,
        tenantId: current.tenantId,
        deploymentId: current.deploymentId,
        bindingFingerprint: current.fingerprint,
      },
      resource.id,
      resource.agentId,
    );
  };
  const odooGrants =
    odooContextSource && odooContextAdapters && odooGrantService
      ? {
          admit: odooAdmission,
          source: {
            sourceInstanceId: odooContextSource.sourceInstanceId,
            baseUrl: odooContextSource.baseUrl,
            database: odooContextSource.database,
          },
          verifyUserProjectScope: odooContextAdapters.verifyUserProjectScope,
          verifyCustomerProjectScope:
            odooContextAdapters.verifyCustomerProjectScope,
          ...odooGrantService,
          ...(readOdooModelPolicy
            ? {
                readModelPolicy: (input: {
                  userId: string;
                  tenantId: string;
                  deploymentId: string;
                  agentId: string;
                }) => readOdooModelPolicy(input),
              }
            : {}),
        }
      : undefined;
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
          recordContext,
          contextHistory,
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
    odooGrants,
  });
  // Disabled means no queue service or connector is constructed. Native membership has
  // no command, requester UID, credential path, or delegated-draft capability.
  const queueBinding =
    config.scoutDelegatedDraftsEnabled && config.scoutQueueBindingsFile
      ? createOwnedQueueBindingReader({
          membership: binding,
          queue: createScoutBindingReader(config.scoutQueueBindingsFile),
          deploymentId,
        })
      : undefined;
  const scout = queueBinding
    ? createScoutService({
        store: createScoutStore(database, async (admitted) => {
          if (
            (await queueBinding({ id: admitted.userId })).fingerprint !==
            admitted.fingerprint
          )
            throw new ScoutError("SCOUT_CONFLICT", 409);
        }),
        binding: queueBinding,
        canReadChannel: async (actor, channelId) =>
          Boolean(
            await channels.get({ id: actor.id, role: "user" }, channelId),
          ),
        connect: createScoutConnector(),
      })
    : undefined;
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
        delegatedDraftsEnabled: config.scoutDelegatedDraftsEnabled,
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
