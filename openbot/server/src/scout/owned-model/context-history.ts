import type { HistoryContextStore } from "../history/context-store";
import { historyDigest } from "../history/protocol";
import {
  type ContextDependency,
  historyContextSchema,
} from "./context-dependency";
import { type ModelGrant, ModelPolicyError } from "./policy";
import {
  type ProjectTaskContextPort,
  type ProjectTaskContextPrincipal,
  resolveProjectTaskContext,
} from "./record-context";

const deny = (): never => {
  throw new ModelPolicyError("MODEL_ACCESS_DENIED");
};
export function createContextHistory(deps: {
  store: HistoryContextStore;
  recordContext?: ProjectTaskContextPort;
  readPolicy?: (
    principal: ProjectTaskContextPrincipal,
    agentId: string,
  ) => Promise<ModelGrant>;
}) {
  return {
    async assertCurrent(
      principal: ProjectTaskContextPrincipal,
      threadId: string,
      agentId: string,
    ) {
      const before = historyContextSchema.safeParse(
        await deps.store.read(principal, threadId),
      );
      if (!before.success) return deny();
      if (before.data.dependencies.length) {
        if (!deps.recordContext || !deps.readPolicy) return deny();
        const grant = await deps.readPolicy(principal, agentId);
        if (!grant.active || Date.parse(grant.expiresAt) <= Date.now())
          return deny();
        for (const dependency of before.data.dependencies) {
          if (
            historyDigest(dependency.principal) !== historyDigest(principal) ||
            dependency.sourceInstanceId !==
              deps.recordContext.sourceInstanceId ||
            dependency.provider !== grant.route.provider ||
            dependency.modelPolicyFingerprint !== grant.fingerprint
          )
            return deny();
          const current = await resolveProjectTaskContext(
            deps.recordContext,
            principal,
            dependency.recordId,
            grant.route.provider,
            grant.fingerprint,
          );
          if (historyDigest(current.dependency) !== historyDigest(dependency))
            return deny();
          await current.assertCurrent(principal, grant.route.provider);
        }
        if (
          (await deps.readPolicy(principal, agentId)).fingerprint !==
          grant.fingerprint
        )
          return deny();
      }
      // Dependency additions while source/policy I/O was pending cannot hide older or newer authority.
      if (
        historyDigest(await deps.store.read(principal, threadId)) !==
        historyDigest(before.data)
      )
        return deny();
      return before.data.revision;
    },
    markRun(
      principal: ProjectTaskContextPrincipal,
      threadId: string,
      agentId: string,
      runId: string,
      revision: number,
    ) {
      return deps.store.markRun(principal, threadId, agentId, runId, revision);
    },
    async remember(
      principal: ProjectTaskContextPrincipal,
      threadId: string,
      agentId: string,
      runId: string,
      dependency: ContextDependency,
    ) {
      if (historyDigest(dependency.principal) !== historyDigest(principal))
        return deny();
      await deps.store.append(principal, threadId, agentId, runId, dependency);
    },
  };
}
export type ContextHistory = ReturnType<typeof createContextHistory>;
