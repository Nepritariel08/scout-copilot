import type { AbstractAgent } from "@ag-ui/client";
import { CopilotRuntime } from "@copilotkit/runtime/v2";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppVariables, AuthenticatedActor } from "../../auth/guards";
import { createHistoryRuntimeHandler } from "../history/endpoint";
import { HistoryError } from "../history/protocol";
import { createHistoryRoutes, historyErrorStatuses } from "../history/routes";
import type { createHistoryEngine } from "../history/runner";
import type { OdooGrantBinding } from "../owned-model/grant-service";
import type { ModelGrant } from "../owned-model/policy";
import type {
  ProjectTaskContextPrincipal,
  ProjectTaskContextProvider,
} from "../owned-model/record-context";
import type { createOwnedAuthority } from "./authority";

const mintInput = z.strictObject({
  agentId: z.string().trim().min(1).max(200),
});
const odooCredentialInput = z.strictObject({
  apiKey: z.string().min(1).max(4096),
});
const releaseConsentInput = z.strictObject({
  agentId: z.string().trim().min(1).max(200),
  consent: z.literal(true),
});
const releaseRevokeInput = z.strictObject({
  agentId: z.string().trim().min(1).max(200),
});

type OwnedOdooGrants = {
  source: { sourceInstanceId: string; baseUrl: string; database: string };
  verifyUserProjectScope(
    apiKey: string,
    expectedUid: number,
    companyIds: number[],
  ): Promise<number[]>;
  issueRecord(input: {
    principal: ProjectTaskContextPrincipal;
    binding: OdooGrantBinding;
    apiKey: string;
    allowedProjectIds: number[];
  }): Promise<unknown>;
  consentRelease(input: {
    principal: ProjectTaskContextPrincipal;
    bindingExpiresAt: string;
    modelPolicyExpiresAt: string;
    provider: ProjectTaskContextProvider;
    modelPolicyFingerprint: string;
  }): Promise<unknown>;
  revokeRelease(input: {
    principal: ProjectTaskContextPrincipal;
    provider: ProjectTaskContextProvider;
    modelPolicyFingerprint: string;
  }): Promise<unknown>;
  status(
    principal: ProjectTaskContextPrincipal,
    provider: ProjectTaskContextProvider,
    modelPolicyFingerprint: string,
  ): Promise<unknown>;
  revokeAll(principal: ProjectTaskContextPrincipal): Promise<unknown>;
  readModelPolicy?(input: {
    userId: string;
    tenantId: string;
    deploymentId: string;
    agentId: string;
  }): Promise<ModelGrant>;
};

function matchesFixedOdooSource(
  binding: Awaited<
    ReturnType<ReturnType<typeof createOwnedAuthority>["binding"]>
  >,
  source: OwnedOdooGrants["source"],
) {
  const { person, policy } = binding;
  const boundOrigin = new URL(policy.environment.SCOUT_ODOO_URL).origin;
  return (
    person.id === policy.userId &&
    boundOrigin === new URL(source.baseUrl).origin &&
    policy.identity.database === source.database &&
    policy.environment.SCOUT_ODOO_DB === source.database &&
    policy.identity.uid > 1 &&
    Number(policy.environment.SCOUT_ODOO_UID) === policy.identity.uid &&
    Number.isFinite(Date.parse(policy.expiresAt)) &&
    Date.parse(policy.expiresAt) > Date.now() &&
    policy.identity.companyIds.length > 0 &&
    policy.identity.companyIds.length <= 100 &&
    policy.identity.companyIds.every(
      (id) => Number.isSafeInteger(id) && id > 0,
    ) &&
    new Set(policy.identity.companyIds).size ===
      policy.identity.companyIds.length
  );
}

function contextPrincipal(
  binding: Awaited<
    ReturnType<ReturnType<typeof createOwnedAuthority>["binding"]>
  >,
): ProjectTaskContextPrincipal {
  return {
    userId: binding.person.id,
    tenantId: binding.policy.tenantId,
    deploymentId: binding.policy.deploymentId,
    bindingFingerprint: binding.policy.fingerprint,
  };
}

function bindingUnchanged(
  before: Awaited<
    ReturnType<ReturnType<typeof createOwnedAuthority>["binding"]>
  >,
  after: Awaited<
    ReturnType<ReturnType<typeof createOwnedAuthority>["binding"]>
  >,
) {
  return (
    before.person.id === after.person.id &&
    before.policy.userId === after.policy.userId &&
    before.policy.fingerprint === after.policy.fingerprint &&
    before.policy.tenantId === after.policy.tenantId &&
    before.policy.deploymentId === after.policy.deploymentId &&
    before.policy.identity.uid === after.policy.identity.uid &&
    before.policy.identity.database === after.policy.identity.database &&
    before.policy.expiresAt === after.policy.expiresAt &&
    before.policy.environment.SCOUT_ODOO_KEY_FILE ===
      after.policy.environment.SCOUT_ODOO_KEY_FILE &&
    JSON.stringify(before.policy.identity.companyIds) ===
      JSON.stringify(after.policy.identity.companyIds) &&
    new URL(before.policy.environment.SCOUT_ODOO_URL).origin ===
      new URL(after.policy.environment.SCOUT_ODOO_URL).origin
  );
}

/** Adapts the existing Scout UI URLs; all identity comes from the native session. */
export function createOwnedRuntimeRoutes(deps: {
  authority: ReturnType<typeof createOwnedAuthority>;
  engine: ReturnType<typeof createHistoryEngine>;
  agents(
    actor: AuthenticatedActor,
    request: Request,
  ): Promise<Record<string, AbstractAgent>>;
  generativeUi: boolean;
  modelReceipts?: (request: Request, threadId: string) => Promise<unknown>;
  odooGrants?: OwnedOdooGrants;
}) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  const bound = (request: Request) =>
    deps.engine.bind(deps.authority.forRequest(request));
  app.use("/api/threads/*", deps.authority.requireTenant);
  app.use("/api/threads/*", bodyLimit({ maxSize: 4000 }));
  app.use("/api/copilotkit/*", deps.authority.requireTenant);
  app.use("/api/scout/model/*", deps.authority.requireTenant);
  app.use("/api/scout/odoo/context-grants", deps.authority.requireTenant);
  app.use("/api/scout/odoo/context-grants/*", deps.authority.requireTenant);
  app.use("/api/scout/odoo/context-grants", bodyLimit({ maxSize: 8192 }));
  app.use("/api/scout/odoo/context-grants/*", bodyLimit({ maxSize: 8192 }));
  app.onError((error, context) =>
    error instanceof HistoryError
      ? context.json({ code: error.code }, historyErrorStatuses[error.code])
      : context.json({ code: "HISTORY_UNAVAILABLE" }, 503),
  );
  app.post("/api/scout/odoo/context-grants", async (context) => {
    const depsGrants = deps.odooGrants;
    if (!depsGrants) return context.json({ code: "MODEL_NOT_CONFIGURED" }, 503);
    const parsed = odooCredentialInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json({ code: "MODEL_ACCESS_DENIED" }, 400);
    const before = await deps.authority.binding(context.req.raw);
    if (!matchesFixedOdooSource(before, depsGrants.source))
      return context.json({ code: "SCOUT_ACCESS_DENIED" }, 403);
    const sourceUid = before.policy.identity.uid;
    const companyIds = [...before.policy.identity.companyIds];
    const allowedProjectIds = await depsGrants.verifyUserProjectScope(
      parsed.data.apiKey,
      sourceUid,
      companyIds,
    );
    const after = await deps.authority.binding(context.req.raw);
    if (
      !matchesFixedOdooSource(after, depsGrants.source) ||
      !bindingUnchanged(before, after)
    )
      return context.json({ code: "SCOUT_ACCESS_DENIED" }, 403);
    const result = await depsGrants.issueRecord({
      principal: contextPrincipal(after),
      binding: {
        sourceUid,
        companyIds,
        bindingExpiresAt: after.policy.expiresAt,
      },
      apiKey: parsed.data.apiKey,
      allowedProjectIds,
    });
    return context.json(result, 201);
  });
  app.post("/api/scout/odoo/context-grants/release", async (context) => {
    const depsGrants = deps.odooGrants;
    if (!depsGrants?.readModelPolicy)
      return context.json({ code: "MODEL_NOT_CONFIGURED" }, 503);
    const parsed = releaseConsentInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json({ code: "MODEL_ACCESS_DENIED" }, 400);
    const before = await deps.authority.binding(context.req.raw);
    if (!matchesFixedOdooSource(before, depsGrants.source))
      return context.json({ code: "SCOUT_ACCESS_DENIED" }, 403);
    const principal = contextPrincipal(before);
    const history = deps.authority.forRequest(context.req.raw);
    if (
      !(await history.authorize(
        principal,
        { agentId: parsed.data.agentId, channelId: null },
        "run",
      ))
    )
      return context.json({ code: "MODEL_ACCESS_DENIED" }, 403);
    const model = await depsGrants.readModelPolicy({
      ...principal,
      agentId: parsed.data.agentId,
    });
    const after = await deps.authority.binding(context.req.raw);
    if (
      !matchesFixedOdooSource(after, depsGrants.source) ||
      !bindingUnchanged(before, after)
    )
      return context.json({ code: "SCOUT_ACCESS_DENIED" }, 403);
    return context.json(
      await depsGrants.consentRelease({
        principal: contextPrincipal(after),
        bindingExpiresAt: after.policy.expiresAt,
        modelPolicyExpiresAt: model.expiresAt,
        provider: model.route.provider,
        modelPolicyFingerprint: model.fingerprint,
      }),
      201,
    );
  });
  app.delete("/api/scout/odoo/context-grants", async (context) => {
    if (!deps.odooGrants)
      return context.json({ code: "MODEL_NOT_CONFIGURED" }, 503);
    const current = await deps.authority.binding(context.req.raw);
    if (!matchesFixedOdooSource(current, deps.odooGrants.source))
      return context.json({ code: "SCOUT_ACCESS_DENIED" }, 403);
    return context.json(
      await deps.odooGrants.revokeAll(contextPrincipal(current)),
    );
  });
  app.get("/api/scout/odoo/context-grants", async (context) => {
    const depsGrants = deps.odooGrants;
    if (!depsGrants?.readModelPolicy)
      return context.json({ code: "MODEL_NOT_CONFIGURED" }, 503);
    const url = new URL(context.req.url);
    const agentIds = url.searchParams.getAll("agentId");
    if (
      agentIds.length !== 1 ||
      [...url.searchParams.keys()].some((key) => key !== "agentId")
    )
      return context.json({ code: "MODEL_ACCESS_DENIED" }, 400);
    const parsed = z.string().trim().min(1).max(200).safeParse(agentIds[0]);
    if (!parsed.success)
      return context.json({ code: "MODEL_ACCESS_DENIED" }, 400);
    const before = await deps.authority.binding(context.req.raw);
    if (!matchesFixedOdooSource(before, depsGrants.source))
      return context.json({ code: "SCOUT_ACCESS_DENIED" }, 403);
    const principal = contextPrincipal(before);
    const history = deps.authority.forRequest(context.req.raw);
    if (
      !(await history.authorize(
        principal,
        { agentId: parsed.data, channelId: null },
        "run",
      ))
    )
      return context.json({ code: "MODEL_ACCESS_DENIED" }, 403);
    const model = await depsGrants.readModelPolicy({
      ...principal,
      agentId: parsed.data,
    });
    const after = await deps.authority.binding(context.req.raw);
    if (
      !matchesFixedOdooSource(after, depsGrants.source) ||
      !bindingUnchanged(before, after)
    )
      return context.json({ code: "SCOUT_ACCESS_DENIED" }, 403);
    return context.json(
      await depsGrants.status(
        contextPrincipal(after),
        model.route.provider,
        model.fingerprint,
      ),
    );
  });
  app.delete("/api/scout/odoo/context-grants/release", async (context) => {
    const depsGrants = deps.odooGrants;
    if (!depsGrants?.readModelPolicy)
      return context.json({ code: "MODEL_NOT_CONFIGURED" }, 503);
    const parsed = releaseRevokeInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json({ code: "MODEL_ACCESS_DENIED" }, 400);
    const before = await deps.authority.binding(context.req.raw);
    if (!matchesFixedOdooSource(before, depsGrants.source))
      return context.json({ code: "SCOUT_ACCESS_DENIED" }, 403);
    const principal = contextPrincipal(before);
    const history = deps.authority.forRequest(context.req.raw);
    if (
      !(await history.authorize(
        principal,
        { agentId: parsed.data.agentId, channelId: null },
        "run",
      ))
    )
      return context.json({ code: "MODEL_ACCESS_DENIED" }, 403);
    const model = await depsGrants.readModelPolicy({
      ...principal,
      agentId: parsed.data.agentId,
    });
    const after = await deps.authority.binding(context.req.raw);
    if (
      !matchesFixedOdooSource(after, depsGrants.source) ||
      !bindingUnchanged(before, after)
    )
      return context.json({ code: "SCOUT_ACCESS_DENIED" }, 403);
    return context.json(
      await depsGrants.revokeRelease({
        principal: contextPrincipal(after),
        provider: model.route.provider,
        modelPolicyFingerprint: model.fingerprint,
      }),
    );
  });
  app.get("/api/scout/model/:threadId/receipts", async (context) => {
    if (!deps.modelReceipts)
      return context.json({ code: "MODEL_NOT_CONFIGURED" }, 503);
    return context.json({
      calls: await deps.modelReceipts(
        context.req.raw,
        context.req.param("threadId"),
      ),
    });
  });
  app.post("/api/threads/mint", async (context) => {
    const parsed = mintInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json({ code: "HISTORY_INPUT_INVALID" }, 400);
    const thread = await bound(context.req.raw).history.mint(parsed.data);
    return context.json({ threadId: thread.id });
  });
  app.get("/api/threads/:threadId", async (context) => {
    try {
      await bound(context.req.raw).history.get(context.req.param("threadId"));
    } catch (error) {
      if (error instanceof HistoryError && error.code === "HISTORY_NOT_FOUND")
        return context.json({ known: false });
      throw error;
    }
    return context.json({ known: true });
  });
  app.route(
    "/api/scout/threads",
    createHistoryRoutes(
      (_actor, request) => bound(request).history,
      deps.authority.requireTenant,
    ),
  );
  app.get("/api/copilotkit/threads/:threadId/messages", async (context) => {
    const history = bound(context.req.raw).history;
    const threadId = context.req.param("threadId");
    const agentId = context.req.query("agentId");
    if (agentId) await history.check(threadId, "read", agentId);
    return context.json(await history.snapshot(threadId));
  });
  app.all("/api/copilotkit/*", async (context) => {
    const current = bound(context.req.raw);
    const runtime = new CopilotRuntime({
      agents: await deps.agents(context.var.actor, context.req.raw),
      runner: current.runner,
      ...(deps.generativeUi ? { openGenerativeUI: true } : {}),
      a2ui: { enabled: deps.generativeUi },
    });
    return createHistoryRuntimeHandler(
      runtime,
      current.history,
      "/api/copilotkit",
    )(context.req.raw);
  });
  const handler = new Hono();
  handler.route("/", app);
  return handler;
}
