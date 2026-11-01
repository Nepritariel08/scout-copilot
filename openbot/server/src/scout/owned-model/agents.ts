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
import type { TenantScope } from "../owned/scope";
import { OwnedTextModel } from "./model";
import {
  createModelPolicyReader,
  ModelPolicyError,
  modelPrincipal,
} from "./policy";
import type { ModelCallStore } from "./store";

class OwnedTextAgent extends RunBuiltAgent {
  run(input: RunAgentInput) {
    // The initial owned pilot releases only owned conversation text, never arbitrary browser context/tools.
    return super.run({ ...input, tools: [], context: [], forwardedProps: {} });
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
        return [
          registered.id,
          new OwnedTextAgent(
            { agentId: registered.id, description: registered.name },
            unavailable,
            async (input, signal) => {
              let bindingFingerprint: string | undefined;
              const authorize = async () => {
                const { person, policy: binding } =
                  await deps.authority.binding(request);
                if (
                  person.id !== actor.id ||
                  (bindingFingerprint !== undefined &&
                    binding.fingerprint !== bindingFingerprint)
                )
                  throw new ModelPolicyError("MODEL_ACCESS_DENIED");
                // A same-tenant requester/company/revision change need not alter the
                // separate model policy. Pin the native source binding for this run.
                bindingFingerprint ??= binding.fingerprint;
                await createBoundHistory(
                  deps.history,
                  deps.authority.forRequest(request),
                ).check(input.threadId, "run", registered.id);
                const grant = await policy(
                  modelPrincipal(person.id, binding, registered.id),
                );
                // History and protected-model reads await I/O. Recheck the pinned
                // requester after those waits, rather than returning an earlier binding.
                const current = await deps.authority.binding(request);
                if (
                  current.person.id !== actor.id ||
                  current.policy.fingerprint !== bindingFingerprint
                )
                  throw new ModelPolicyError("MODEL_ACCESS_DENIED");
                return grant;
              };
              const grant = await authorize();
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
                ...(grant.allowPersonalInstructions
                  ? {
                      loadInstructionsForActor: (userId: string) => () =>
                        instructions.read(userId),
                    }
                  : {}),
              }).resolveAgentForActor(actor, registered.id);
            },
          ),
        ];
      }),
    );
}
