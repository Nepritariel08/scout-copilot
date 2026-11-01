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
import type {
  OdooAdmission,
  OdooAdmissionReader,
} from "../owned-model/odoo-binding";
import { type ModelGrant, ModelPolicyError } from "../owned-model/policy";
import type {
  ProjectTaskContextPrincipal,
  ProjectTaskContextProvider,
} from "../owned-model/record-context";
import { ScoutError } from "../types";
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
  expectedProvider: z.enum(["openrouter", "local"]),
  expectedModel: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,199}$/),
  expectedPolicyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
const releaseRevokeInput = z.strictObject({
  agentId: z.string().trim().min(1).max(200),
});

type OwnedOdooGrants = {
  admit?: OdooAdmissionReader;
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
    assertCurrent(): Promise<void>;
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
  revokeAll(
    principal: ProjectTaskContextPrincipal,
    options?: { allBindingRevisions?: boolean; releasesOnly?: boolean },
  ): Promise<unknown>;
  readModelPolicy?(input: {
    userId: string;
    tenantId: string;
    deploymentId: string;
    agentId: string;
  }): Promise<ModelGrant>;
};

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
    before.policy.expiresAt === after.policy.expiresAt
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
  async function withCurrentAdmission<T>(
    request: Request,
    before: Awaited<ReturnType<typeof deps.authority.binding>>,
    admission: OdooAdmission,
    work: () => Promise<T>,
  ): Promise<T> {
    const check = async () => {
      try {
        await admission.assertCurrent();
        if (!bindingUnchanged(before, await deps.authority.binding(request)))
          throw new ModelPolicyError("MODEL_ACCESS_DENIED");
      } catch (error) {
        if (error instanceof ScoutError && error.code === "SCOUT_ACCESS_DENIED")
          throw new ModelPolicyError("MODEL_ACCESS_DENIED");
        throw error;
      }
    };
    await check();
    const result = await work();
    await check();
    return result;
  }
  async function withCurrentMembership<T>(
    request: Request,
    before: Awaited<ReturnType<typeof deps.authority.binding>>,
    work: () => Promise<T>,
  ): Promise<T> {
    const check = async () => {
      if (!bindingUnchanged(before, await deps.authority.binding(request)))
        throw new ModelPolicyError("MODEL_ACCESS_DENIED");
    };
    await check();
    const result = await work();
    await check();
    return result;
  }
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
  app.onError((error, context) => {
    if (error instanceof HistoryError)
      return context.json(
        { code: error.code },
        historyErrorStatuses[error.code],
      );
    if (error instanceof ModelPolicyError)
      return context.json(
        { code: error.code },
        error.code === "MODEL_ACCESS_DENIED"
          ? 403
          : error.code === "MODEL_CONFLICT"
            ? 409
            : 503,
      );
    return context.json({ code: "HISTORY_UNAVAILABLE" }, 503);
  });
  app.post("/api/scout/odoo/context-grants", async (context) => {
    const depsGrants = deps.odooGrants;
    if (!depsGrants?.admit)
      return context.json({ code: "MODEL_NOT_CONFIGURED" }, 503);
    const parsed = odooCredentialInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json({ code: "MODEL_ACCESS_DENIED" }, 400);
    const before = await deps.authority.binding(context.req.raw);
    const admission = await depsGrants.admit(contextPrincipal(before));
    const sourceUid = admission.binding.sourceUid;
    const companyIds = [...admission.binding.companyIds];
    const allowedProjectIds = await depsGrants.verifyUserProjectScope(
      parsed.data.apiKey,
      sourceUid,
      companyIds,
    );

    const result = await withCurrentAdmission(
      context.req.raw,
      before,
      admission,
      () =>
        depsGrants.issueRecord({
          principal: admission.principal,
          binding: {
            sourceUid,
            companyIds,
            bindingExpiresAt: admission.expiresAt,
          },
          apiKey: parsed.data.apiKey,
          allowedProjectIds,
        }),
    );
    return context.json(result, 201);
  });
  app.post("/api/scout/odoo/context-grants/release", async (context) => {
    const depsGrants = deps.odooGrants;
    if (!depsGrants?.readModelPolicy || !depsGrants.admit)
      return context.json({ code: "MODEL_NOT_CONFIGURED" }, 503);
    const readModelPolicy = depsGrants.readModelPolicy;
    const parsed = releaseConsentInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json({ code: "MODEL_ACCESS_DENIED" }, 400);
    const before = await deps.authority.binding(context.req.raw);
    const admission = await depsGrants.admit(contextPrincipal(before));
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
    const model = await readModelPolicy({
      ...principal,
      agentId: parsed.data.agentId,
    });
    const assertModel = (current: ModelGrant) => {
      if (
        current.fingerprint !== parsed.data.expectedPolicyFingerprint ||
        current.route.provider !== parsed.data.expectedProvider ||
        current.route.model !== parsed.data.expectedModel ||
        !(Date.parse(current.expiresAt) > Date.now())
      )
        throw new ModelPolicyError("MODEL_CONFLICT");
    };
    assertModel(model);
    // The displayed route is a precondition, never authority to select a route.
    // Recheck after DB waits and inside the transaction before it can commit.
    const assertCurrent = () =>
      withCurrentAdmission(context.req.raw, before, admission, async () => {
        assertModel(
          await readModelPolicy({
            ...principal,
            agentId: parsed.data.agentId,
          }),
        );
      });

    return context.json(
      await withCurrentAdmission(context.req.raw, before, admission, () =>
        depsGrants.consentRelease({
          principal: admission.principal,
          bindingExpiresAt: admission.expiresAt,
          modelPolicyExpiresAt: model.expiresAt,
          provider: model.route.provider,
          modelPolicyFingerprint: model.fingerprint,
          assertCurrent,
        }),
      ),
      201,
    );
  });
  app.delete("/api/scout/odoo/context-grants", async (context) => {
    if (!deps.odooGrants)
      return context.json({ code: "MODEL_NOT_CONFIGURED" }, 503);
    const current = await deps.authority.binding(context.req.raw);
    const grants = deps.odooGrants;
    return context.json(
      await withCurrentMembership(context.req.raw, current, () =>
        grants.revokeAll(contextPrincipal(current), {
          allBindingRevisions: true,
        }),
      ),
    );
  });
  app.get("/api/scout/odoo/context-grants", async (context) => {
    const depsGrants = deps.odooGrants;
    if (!depsGrants?.readModelPolicy || !depsGrants.admit)
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
    const admission = await depsGrants.admit(contextPrincipal(before));
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

    const status = await withCurrentAdmission(
      context.req.raw,
      before,
      admission,
      () =>
        depsGrants.status(
          admission.principal,
          model.route.provider,
          model.fingerprint,
        ),
    );
    // A stale status cannot mint consent, but do not knowingly display a route
    // that changed while its scoped grant status was being read either.
    const currentModel = await depsGrants.readModelPolicy({
      ...principal,
      agentId: parsed.data,
    });
    if (currentModel.fingerprint !== model.fingerprint)
      throw new ModelPolicyError("MODEL_CONFLICT");
    await withCurrentAdmission(
      context.req.raw,
      before,
      admission,
      async () => {},
    );
    return context.json(
      Object.assign({}, status, {
        route: {
          provider: model.route.provider,
          model: model.route.model,
          policyFingerprint: model.fingerprint,
          expiresAt: model.expiresAt,
        },
      }),
    );
  });
  app.delete("/api/scout/odoo/context-grants/release", async (context) => {
    const grants = deps.odooGrants;
    if (!grants) return context.json({ code: "MODEL_NOT_CONFIGURED" }, 503);
    const parsed = releaseRevokeInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json({ code: "MODEL_ACCESS_DENIED" }, 400);
    const current = await deps.authority.binding(context.req.raw);
    // Withdrawal cannot grant access. It applies to this member's own fixed-source
    // consents across old policy revisions, even when Odoo/model admission is gone.
    return context.json(
      await withCurrentMembership(context.req.raw, current, () =>
        grants.revokeAll(contextPrincipal(current), {
          allBindingRevisions: true,
          releasesOnly: true,
        }),
      ),
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
