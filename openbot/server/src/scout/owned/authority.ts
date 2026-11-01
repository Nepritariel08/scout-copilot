import type { MiddlewareHandler } from "hono";
import type { AgentProfileStore } from "../../agents/profile-store";
import {
  type AppVariables,
  type AuthenticatedActor,
  type AuthService,
  createRequireUser,
  type RoleRepository,
} from "../../auth/guards";
import type { ChannelStore } from "../../channels/routes";
import { HistoryError } from "../history/protocol";
import type { HistoryAuthority } from "../history/service";
import type { ScoutActor, ScoutBinding } from "../types";

export type BindingReader = (actor: ScoutActor) => Promise<ScoutBinding>;

/** Revalidate native identity and membership on every call; no mutable global current user. */
export function createOwnedAuthority(deps: {
  auth: AuthService;
  roles: RoleRepository;
  binding: BindingReader;
  profiles: Pick<AgentProfileStore, "get">;
  channels: Pick<ChannelStore, "get">;
}) {
  async function actor(request: Request): Promise<AuthenticatedActor> {
    const session = await deps.auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    });
    if (!session?.user) throw new HistoryError("HISTORY_ACCESS_DENIED");
    const roles = session.user.role
      ? [session.user.role]
      : await deps.roles.rolesForUser(session.user.id);
    const role = roles.includes("admin")
      ? "admin"
      : roles.includes("user")
        ? "user"
        : null;
    if (!role) throw new HistoryError("HISTORY_ACCESS_DENIED");
    return { ...session.user, role };
  }
  const binding = async (request: Request) => {
    const person = await actor(request);
    const policy = await deps.binding(person);
    return { person, policy };
  };
  const requireUser = createRequireUser(deps.auth, deps.roles);
  return {
    actor,
    binding,
    forRequest(request: Request): HistoryAuthority {
      return {
        principal: async () => {
          const { person, policy } = await binding(request);
          return { userId: person.id, tenantId: policy.tenantId };
        },
        authorize: async (scope, resource) => {
          const { person, policy } = await binding(request);
          if (scope.userId !== person.id || scope.tenantId !== policy.tenantId)
            return false;
          if (!(await deps.profiles.get(person, resource.agentId)))
            return false;
          if (!resource.channelId) return true;
          const channel = await deps.channels.get(person, resource.channelId);
          return Boolean(
            channel?.agentIds.includes(resource.agentId) &&
              (!resource.id || resource.id === channel.threadId),
          );
        },
      };
    },
    requireTenant: (async (context, next) =>
      requireUser(context, async () => {
        try {
          const { person } = await binding(context.req.raw);
          context.set("actor", person);
        } catch {
          context.res = context.json({ code: "SCOUT_ACCESS_DENIED" }, 403);
          return;
        }
        await next();
      })) satisfies MiddlewareHandler<{ Variables: AppVariables }>,
  };
}
