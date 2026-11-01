import type { AuthService, RoleRepository } from "../../auth/guards";
import type { OpenBotRole } from "../../auth/roles";
import type { TenantScope } from "./scope";

/** A native global admin is not automatically a platform owner in the owned composition. */
export function createOwnedIdentity(deps: {
  auth: AuthService;
  roles: RoleRepository;
  scope: TenantScope;
  platformOwnerIds: readonly string[];
}) {
  const owners = new Set(deps.platformOwnerIds);
  function role(userId: string, native: OpenBotRole[]): OpenBotRole | null {
    if (native.includes("admin")) return owners.has(userId) ? "admin" : "user";
    return native.includes("user") ? "user" : null;
  }
  const roles: RoleRepository = {
    async rolesForUser(userId) {
      try {
        await deps.scope.resolve(userId);
        const selected = role(userId, await deps.roles.rolesForUser(userId));
        return selected ? [selected] : [];
      } catch {
        return [];
      }
    },
  };
  const auth: AuthService = {
    handler: deps.auth.handler,
    api: {
      async getSession(input) {
        const session = await deps.auth.api.getSession({
          ...input,
          query: { disableCookieCache: true },
        });
        if (!session?.user) return null;
        try {
          // Identity remains visible when tenant access is withdrawn; the tenant middleware and
          // platform-owner boundary recheck membership and report its own refusal.
          const selected = role(
            session.user.id,
            session.user.role
              ? [session.user.role]
              : await deps.roles.rolesForUser(session.user.id),
          );
          return selected
            ? { ...session, user: { ...session.user, role: selected } }
            : null;
        } catch {
          return null;
        }
      },
    },
  };
  return { auth, roles };
}
