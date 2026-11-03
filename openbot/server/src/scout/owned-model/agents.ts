import type { AbstractAgent, RunAgentInput } from "@ag-ui/client";
import {
  RunBuiltAgent,
  UnavailableAgent,
} from "@openbot/toolkit/copilotkit/agents";
import { createActorAgentResolver } from "../../agents/agent-resolver";
import { createRuntimeAgentLoader } from "../../agents/runtime-agents";
import type { AuthenticatedActor } from "../../auth/guards";
import type { Database } from "../../db/client";
import { createUserInstructionsStore } from "../../user-instructions";
import { createBoundHistory } from "../history/service";
import type { HistoryStore } from "../history/store";
import type { createOwnedAuthority } from "../owned/authority";
import type { OwnedCatalog } from "../owned/catalog";
import type { TenantScope } from "../owned/scope";
import type { OwnedComputerService } from "../owned-computer/service";
import { OwnedCapabilityTool } from "./capability-tool";
import type { ContextHistory } from "./context-history";
import { OwnedTextModel } from "./model";
import {
  createModelPolicyReader,
  ModelPolicyError,
  modelPrincipal,
} from "./policy";
import {
  type ProjectTaskContextPort,
  type ProjectTaskSelection,
  type ResolvedProjectTaskContext,
  resolveProjectTaskContext,
  selectProjectTask,
} from "./record-context";
import type { ModelCallStore } from "./store";

class OwnedTextAgent extends RunBuiltAgent {
  constructor(
    identity: { agentId: string; description: string },
    whole: UnavailableAgent,
    build: ConstructorParameters<typeof RunBuiltAgent>[2],
    private selections: WeakMap<RunAgentInput, ProjectTaskSelection>,
  ) {
    super(identity, whole, build);
  }

  run(input: RunAgentInput) {
    // Keep only one typed, untrusted selection hint in a private weak map. The actual input passed
    // to the agent and provider has all browser context, tools and forwarded props removed.
    const sanitized = { ...input, tools: [], context: [], forwardedProps: {} };
    this.selections.set(sanitized, selectProjectTask(input.context));
    return super.run(sanitized);
  }

  clone(): OwnedTextAgent {
    const cloned = super.clone() as OwnedTextAgent;
    cloned.selections = this.selections;
    return cloned;
  }
}

export function createOwnedModelAgents(deps: {
  database: Database;
  policyFile: string;
  authority: ReturnType<typeof createOwnedAuthority>;
  history: HistoryStore;
  calls: ModelCallStore;
  transport?: typeof fetch;
  scope?: TenantScope;
  /** Test-only trusted adapter seam. Production leaves this absent until source identity is qualified. */
  recordContext?: ProjectTaskContextPort;
  contextHistory: ContextHistory;
  catalog?: OwnedCatalog;
  computer?: OwnedComputerService;
}) {
  const load = createRuntimeAgentLoader(
    deps.database,
    undefined,
    undefined,
    deps.scope,
  );
  const policy = createModelPolicyReader(deps.policyFile);
  const instructions = createUserInstructionsStore(deps.database, deps.scope);
  return async (
    actor: AuthenticatedActor,
    request: Request,
  ): Promise<Record<string, AbstractAgent>> =>
    Object.fromEntries(
      (await load(actor)).map((registered) => {
        const unavailable = new UnavailableAgent({
          id: registered.id,
          name: registered.name,
          reason: "MODEL_UNAVAILABLE",
        });
        if (registered.type !== "built_in") return [registered.id, unavailable];
        const selections = new WeakMap<RunAgentInput, ProjectTaskSelection>();
        return [
          registered.id,
          new OwnedTextAgent(
            { agentId: registered.id, description: registered.name },
            unavailable,
            async (input, signal) => {
              const selection = selections.get(input) ?? { kind: "none" };
              let selectedContext: ResolvedProjectTaskContext | undefined;
              let rememberedContext = false;
              let markedRun = false;
              let bindingFingerprint: string | undefined;
              const authorize = async () => {
                if (selection.kind === "invalid")
                  throw new ModelPolicyError("MODEL_ACCESS_DENIED");
                const { person, policy: binding } =
                  await deps.authority.binding(request);
                if (
                  person.id !== actor.id ||
                  (bindingFingerprint !== undefined &&
                    binding.fingerprint !== bindingFingerprint)
                )
                  throw new ModelPolicyError("MODEL_ACCESS_DENIED");
                // A same-tenant membership revision need not alter the separate
                // model policy. Pin native admission independently for this run.
                bindingFingerprint ??= binding.fingerprint;
                await createBoundHistory(
                  deps.history,
                  deps.authority.forRequest(request),
                ).check(input.threadId, "run", registered.id);
                const grant = await policy(
                  modelPrincipal(person.id, binding, registered.id),
                );
                const contextPrincipal = {
                  userId: person.id,
                  tenantId: binding.tenantId,
                  deploymentId: binding.deploymentId,
                  bindingFingerprint: binding.fingerprint,
                };
                // Includes every dependency inherited by ordinary continuation, not just this selection.
                let contextRevision = await deps.contextHistory.assertCurrent(
                  contextPrincipal,
                  input.threadId,
                  registered.id,
                );
                // History and protected-model reads await I/O. Recheck the pinned
                // membership after those waits, rather than returning an earlier binding.
                const current = await deps.authority.binding(request);
                if (
                  current.person.id !== actor.id ||
                  current.policy.fingerprint !== bindingFingerprint
                )
                  throw new ModelPolicyError("MODEL_ACCESS_DENIED");
                if (selection.kind === "selected") {
                  if (!deps.recordContext || !deps.contextHistory)
                    throw new ModelPolicyError("MODEL_ACCESS_DENIED");
                  const principal = {
                    userId: current.person.id,
                    tenantId: current.policy.tenantId,
                    deploymentId: current.policy.deploymentId,
                    bindingFingerprint: current.policy.fingerprint,
                  };
                  if (!selectedContext)
                    selectedContext = await resolveProjectTaskContext(
                      deps.recordContext,
                      principal,
                      selection.recordId,
                      grant.route.provider,
                      grant.fingerprint,
                    );
                  else
                    await selectedContext.assertCurrent(
                      principal,
                      grant.route.provider,
                    );
                  if (!rememberedContext) {
                    await deps.contextHistory.remember(
                      principal,
                      input.threadId,
                      registered.id,
                      input.runId,
                      selectedContext.dependency,
                    );
                    rememberedContext = true;
                    contextRevision = await deps.contextHistory.assertCurrent(
                      principal,
                      input.threadId,
                      registered.id,
                    );
                  }
                  // Source and grant reads can await remote I/O. Pin native
                  // identity again after they finish, before authorizing egress.
                  const afterContext = await deps.authority.binding(request);
                  if (
                    afterContext.person.id !== actor.id ||
                    afterContext.policy.fingerprint !== bindingFingerprint ||
                    afterContext.policy.tenantId !== principal.tenantId ||
                    afterContext.policy.deploymentId !== principal.deploymentId
                  )
                    throw new ModelPolicyError("MODEL_ACCESS_DENIED");
                }
                if (!markedRun) {
                  await deps.contextHistory.markRun(
                    contextPrincipal,
                    input.threadId,
                    registered.id,
                    input.runId,
                    contextRevision,
                  );
                  markedRun = true;
                }
                return grant;
              };
              const grant = await authorize();
              const computerService = deps.computer;
              const capabilityTool =
                grant.allowedToolNames && deps.catalog
                  ? new OwnedCapabilityTool(
                      deps.catalog,
                      grant,
                      authorize,
                      signal,
                      computerService
                        ? async (context) => {
                            const computer = await computerService.forRequest(
                              request,
                              registered.id,
                            );
                            return computer.readPublic({
                              ...context,
                              threadId: input.threadId,
                              runId: input.runId,
                            });
                          }
                        : undefined,
                    )
                  : undefined;
              const model = new OwnedTextModel(
                {
                  userId: actor.id,
                  tenantId: grant.tenantId,
                  deploymentId: grant.deploymentId,
                  agentId: registered.id,
                  threadId: input.threadId,
                  runId: input.runId,
                },
                grant,
                authorize,
                deps.calls,
                signal,
                deps.transport,
                selectedContext?.prompt,
                capabilityTool,
              );
              return createActorAgentResolver({
                loadAgents: async (current) =>
                  (await load(current)).filter(
                    (agent) => agent.type === "built_in",
                  ),
                model: {
                  provider: "openai",
                  defaultModel: grant.route.model,
                  languageModel: model,
                },
                resolveModelApiKey: async () => null,
                ...(capabilityTool
                  ? {
                      loadToolsForActor:
                        (userId: string) => async (botId: string) => {
                          if (userId !== actor.id || botId !== registered.id)
                            throw new ModelPolicyError("MODEL_ACCESS_DENIED");
                          return capabilityTool.grantedTools();
                        },
                    }
                  : {}),
                ...(grant.allowPersonalInstructions
                  ? {
                      loadInstructionsForActor: (userId: string) => () =>
                        instructions.read(userId),
                    }
                  : {}),
              }).resolveAgentForActor(actor, registered.id);
            },
            selections,
          ),
        ];
      }),
    );
}
