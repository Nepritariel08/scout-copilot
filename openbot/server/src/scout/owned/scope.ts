import {
  and,
  eq,
  isNotNull,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import type { Database } from "../../db/client";
import { agents, deploymentPackages } from "../../db/schema/core";
import { scoutResourceScopes as resources } from "../../db/schema/scout-scope";
import type { MembershipReader } from "../membership";
import { ScoutError } from "../types";

export type ScopeTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];
export type TenantPrincipal = {
  userId: string;
  tenantId: string;
  deploymentId: string;
  fingerprint: string;
};
export type ResourceKind = "agent" | "channel" | "page";
export type TenantScope = {
  resolve(userId: string): Promise<TenantPrincipal>;
  assertCurrent(principal: TenantPrincipal): Promise<void>;
  /** Always combine with the store's native owner/visibility/membership predicate. */
  predicate(
    principal: TenantPrincipal,
    kind: ResourceKind,
    id: SQLWrapper,
    mode?: "read" | "write",
  ): SQL;
  /** Call only in the same transaction that creates the resource. Ownership is never reassigned. */
  stamp(
    transaction: ScopeTransaction,
    principal: TenantPrincipal,
    kind: ResourceKind,
    id: string,
  ): Promise<void>;
};
const denied = () => new ScoutError("SCOUT_ACCESS_DENIED", 403);

export function createTenantScope(deps: {
  binding: MembershipReader;
  deploymentId: string;
}): TenantScope & {
  seedTemplates(
    transaction: ScopeTransaction,
    packageTenantId: string,
    agentIds: string[],
  ): Promise<void>;
} {
  async function resolve(userId: string): Promise<TenantPrincipal> {
    try {
      const value = await deps.binding({ id: userId });
      if (
        !userId ||
        value.userId !== userId ||
        !value.tenantId ||
        !value.fingerprint ||
        !(Date.parse(value.expiresAt) > Date.now()) ||
        value.deploymentId !== deps.deploymentId
      )
        throw denied();
      return {
        userId,
        tenantId: value.tenantId,
        deploymentId: value.deploymentId,
        fingerprint: value.fingerprint,
      };
    } catch {
      throw denied();
    }
  }
  async function assertCurrent(principal: TenantPrincipal) {
    const current = await resolve(principal.userId);
    if (
      current.tenantId !== principal.tenantId ||
      current.deploymentId !== principal.deploymentId ||
      current.fingerprint !== principal.fingerprint
    )
      throw denied();
  }
  async function insertScope(
    tx: ScopeTransaction,
    input: typeof resources.$inferInsert,
  ) {
    await tx.insert(resources).values(input).onConflictDoNothing();
    const [existing] = await tx
      .select()
      .from(resources)
      .where(
        and(
          eq(resources.resourceKind, input.resourceKind),
          eq(resources.resourceId, input.resourceId),
        ),
      );
    if (
      !existing ||
      existing.deploymentId !== input.deploymentId ||
      existing.tenantId !== (input.tenantId ?? null) ||
      existing.scopeKind !== input.scopeKind
    )
      throw new ScoutError("SCOUT_CONFLICT", 409);
  }
  return {
    resolve,
    assertCurrent,
    predicate(principal, kind, id, mode = "read") {
      return sql`exists (select 1 from ${resources} where ${resources.resourceKind} = ${kind} and ${resources.resourceId} = ${id} and ${resources.deploymentId} = ${principal.deploymentId} and ((${resources.scopeKind} = 'tenant' and ${resources.tenantId} = ${principal.tenantId}) or (${mode === "read"} and ${kind === "agent"} and ${resources.scopeKind} = 'template' and ${resources.tenantId} is null)))`;
    },
    async stamp(tx, principal, kind, id) {
      await assertCurrent(principal);
      await insertScope(tx, {
        resourceKind: kind,
        resourceId: id,
        deploymentId: principal.deploymentId,
        tenantId: principal.tenantId,
        scopeKind: "tenant",
      });
      await assertCurrent(principal);
    },
    async seedTemplates(tx, packageTenantId, agentIds) {
      for (const id of agentIds) {
        const [curated] = await tx
          .select({ id: agents.id })
          .from(agents)
          .innerJoin(
            deploymentPackages,
            eq(deploymentPackages.id, agents.packageId),
          )
          .where(
            and(
              eq(agents.id, id),
              isNotNull(agents.packageId),
              eq(deploymentPackages.tenantId, packageTenantId),
            ),
          );
        if (!curated) throw denied();
        await insertScope(tx, {
          resourceKind: "agent",
          resourceId: id,
          deploymentId: deps.deploymentId,
          tenantId: null,
          scopeKind: "template",
        });
      }
    },
  };
}
