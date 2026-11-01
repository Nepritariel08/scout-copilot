import { describe, expect, test } from "bun:test";
import {
  ownedApiAllowed,
  ownedAuthAllowed,
} from "../src/scout/owned/capabilities";

describe("owned private-pilot HTTP capability admission", () => {
  test("preserves the qualified conversation, resource, native shell and platform administration routes", () => {
    const routes: [string, string][] = [
      ["GET", "/api/capabilities"],
      ["GET", "/api/me"],
      ["POST", "/api/me/onboarding"],
      ["GET", "/api/settings/preferences"],
      ["PATCH", "/api/settings/preferences"],
      ["GET", "/api/settings/instructions"],
      ["PUT", "/api/settings/instructions"],
      ["GET", "/api/agents"],
      ["POST", "/api/agents"],
      ["GET", "/api/agents/capabilities"],
      ["GET", "/api/agents/agent_123"],
      ["PATCH", "/api/agents/agent_123"],
      ["DELETE", "/api/agents/agent_123"],
      ["GET", "/api/agents/agent_123/handoff"],
      ...[
        "declined",
        "duplicate",
        "hide",
        "unhide",
        "pin",
        "unpin",
        "callback-token",
      ].map((action): [string, string] => [
        "POST",
        `/api/agents/agent_123/${action}`,
      ]),
      ["DELETE", "/api/agents/agent_123/callback-token"],
      ["GET", "/api/channels"],
      ["POST", "/api/channels"],
      ["GET", "/api/channels/events"],
      ["POST", "/api/channels/first-day"],
      ["GET", "/api/channels/channel_123"],
      ["DELETE", "/api/channels/channel_123"],
      ...["activity", "busy", "attachments"].map((action): [string, string] => [
        "POST",
        `/api/channels/channel_123/${action}`,
      ]),
      ["PUT", "/api/channels/channel_123/pin"],
      ["PUT", "/api/channels/channel_123/read"],
      ["GET", "/api/attachments/attachment_123"],
      ["HEAD", "/api/attachments/attachment_123"],
      ["DELETE", "/api/attachments/attachment_123"],
      ["GET", "/api/openduet/pages"],
      ["GET", "/api/openduet/pages/page_123"],
      ["DELETE", "/api/openduet/pages/page_123"],
      ["PATCH", "/api/openduet/pages/page_123/checklist"],
      ["GET", "/api/openduet/channels"],
      ["POST", "/api/openduet/channels"],
      ["PATCH", "/api/openduet/channels/channel_123"],
      ...["archive", "unarchive", "keep"].map((action): [string, string] => [
        "POST",
        `/api/openduet/channels/channel_123/${action}`,
      ]),
      ["POST", "/api/threads/mint"],
      ["GET", "/api/threads/thread_123"],
      ["GET", "/api/scout/threads"],
      ["POST", "/api/scout/threads"],
      ["GET", "/api/scout/threads/thread_123/messages"],
      ["GET", "/api/scout/threads/thread_123/events"],
      ["POST", "/api/scout/threads/thread_123/stop"],
      ["GET", "/api/scout/model/thread_123/receipts"],
      ["POST", "/api/scout/odoo/context-grants"],
      ["POST", "/api/scout/odoo/context-grants/release"],
      ["DELETE", "/api/scout/odoo/context-grants"],
      ...[
        "status",
        "audit-events",
        "people",
        "identity-providers",
        "credentials",
        "package",
      ].map((name): [string, string] => ["GET", `/api/admin/${name}`]),
      ["POST", "/api/admin/people/native-user/role"],
      ["POST", "/api/admin/people/native-user/access"],
      ["DELETE", "/api/admin/identity-providers/provider_123"],
      ["POST", "/api/admin/credentials"],
      ["POST", "/api/admin/credentials/credential_123/rotate"],
      ["POST", "/api/admin/credentials/credential_123/revoke"],
      ["GET", "/api/admin/enterprise/me"],
    ];
    for (const [method, path] of routes)
      expect({ method, path, allowed: ownedApiAllowed(path, method) }).toEqual({
        method,
        path,
        allowed: true,
      });
  });

  test("admits only the public runner routes whose owned history and model contracts are adapted", () => {
    const supported: [string, string][] = [
      ["GET", "/api/copilotkit/info"],
      ["GET", "/api/copilotkit/threads/thread_123/messages"],
      ["POST", "/api/copilotkit/agent/scout/run"],
      ["POST", "/api/copilotkit/agent/scout/connect"],
      ["POST", "/api/copilotkit/agent/scout/stop/thread_123"],
    ];
    for (const [method, path] of supported)
      expect(ownedApiAllowed(path, method)).toBe(true);
    const unsupported = [
      "/api/copilotkit",
      "/api/copilotkit/agent/scout/suggest",
      "/api/copilotkit/trajectory/id/connect",
      "/api/copilotkit/threads",
      "/api/copilotkit/threads/subscribe",
      "/api/copilotkit/threads/id/events",
      "/api/copilotkit/threads/id/state",
      "/api/copilotkit/threads/id/archive",
      "/api/copilotkit/memories",
      "/api/copilotkit/memories/recall",
      "/api/copilotkit/transcribe",
      "/api/copilotkit/inspector-metadata",
      "/api/copilotkit/inspector-learning",
      "/api/copilotkit/cpk-debug-events",
      "/api/copilotkit/extra/info",
      "/api/copilotkit/extra/agent/scout/run",
      "/api/copilotkit/extra/agent/scout/stop/thread_123",
    ];
    for (const path of unsupported)
      for (const method of ["GET", "POST", "PATCH", "DELETE"])
        expect(ownedApiAllowed(path, method)).toBe(false);
    expect(
      ownedApiAllowed("/api/copilotkit/agent/scout/stop/thread_123", "DELETE"),
    ).toBe(false);
    expect(ownedApiAllowed("/api/copilotkit/info", "POST")).toBe(false);
    expect(ownedApiAllowed("/api/copilotkit/agent/scout/run", "GET")).toBe(
      false,
    );
  });

  test("keeps delegated drafts opt-in without authorizing another optional feature", () => {
    for (const [method, path] of [
      ["GET", "/api/scout/tasks"],
      ["POST", "/api/scout/tasks"],
      ["POST", "/api/scout/tasks/task_123"],
    ]) {
      expect(ownedApiAllowed(path!, method!)).toBe(false);
      expect(ownedApiAllowed(path!, method!, { delegatedDrafts: false })).toBe(
        false,
      );
      expect(ownedApiAllowed(path!, method!, { delegatedDrafts: true })).toBe(
        true,
      );
    }
    expect(
      ownedApiAllowed("/api/scout/tasks/task_123", "DELETE", {
        delegatedDrafts: true,
      }),
    ).toBe(false);
    expect(
      ownedApiAllowed("/api/scout/tasks/task_123/replay", "POST", {
        delegatedDrafts: true,
      }),
    ).toBe(false);
    expect(
      ownedApiAllowed("/api/plugins/call", "POST", { delegatedDrafts: true }),
    ).toBe(false);
  });

  test("newly supplied feature stores cannot open optional execution, knowledge or native scheduler routes", () => {
    const optional = [
      "/api/routines",
      "/api/routines/id/run",
      "/api/delivery",
      "/api/delivery/webhooks",
      "/api/demonstrations",
      "/api/bots/id/reset",
      "/api/groups",
      "/api/team-bots",
      "/api/approvals",
      "/api/approvals/shared-use",
      "/api/sign-in-requests",
      "/api/passwords",
      "/api/proactive/settings",
      "/api/openduet/setup",
      "/api/openduet/tasks",
      "/api/memory",
      "/api/memory/sources",
      "/api/responsibilities",
      "/api/events/github",
      "/api/events/triggers",
      "/api/events/email",
      "/api/components",
      "/api/plugins",
      "/api/plugins/for/scout/apps",
      "/api/agent-tools/call",
      "/api/sandboxed",
      "/api/computers",
      "/api/host-access",
      "/api/route",
      "/api/identity",
      "/api/identity/github/callback",
      "/api/audio/transcriptions",
      "/api/voice/sessions",
      "/api/admin/learning/settings",
      "/api/admin/enterprise",
      "/api/admin/enterprise/capabilities",
      "/api/admin/enterprise/models/usage",
      "/api/admin/enterprise/people/id/terminate-computers",
      "/api/admin/future-feature",
      "/api/future-adapter",
    ];
    for (const path of optional)
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"])
        expect(ownedApiAllowed(path, method)).toBe(false);
    expect(ownedApiAllowed("/api/agents/test-connection", "POST")).toBe(false);
    expect(ownedApiAllowed("/api/channels/morning-brief", "POST")).toBe(false);
    for (const [path, method] of [
      ["/api/scout/odoo/context-grants", "GET"],
      ["/api/scout/odoo/context-grants", "PUT"],
      ["/api/scout/odoo/context-grants/release", "DELETE"],
      ["/api/scout/odoo/context-grants/release/extra", "POST"],
    ])
      expect(ownedApiAllowed(path!, method!)).toBe(false);
  });

  test("preserves installed login, session, desktop/mobile and owner-managed SSO protocol routes", () => {
    const routes: [string, string][] = [
      ["GET", "/api/auth/get-session"],
      ["POST", "/api/auth/get-session"],
      ["GET", "/api/auth/organization/session"],
      ["POST", "/api/auth/organization/session"],
      ...[
        "sign-out",
        "revoke-session",
        "revoke-sessions",
        "revoke-other-sessions",
      ].map((path): [string, string] => ["POST", `/api/auth/${path}`]),
      ...["list-sessions", "desktop", "ok", "error"].map(
        (path): [string, string] => ["GET", `/api/auth/${path}`],
      ),
      ["POST", "/api/auth/sign-in/social"],
      ["POST", "/api/auth/sign-in/sso"],
      ["GET", "/api/auth/callback/google"],
      ["POST", "/api/auth/callback/microsoft"],
      ["POST", "/api/auth/electron/token"],
      ["POST", "/api/auth/electron/transfer-user"],
      ["GET", "/api/auth/electron/init-oauth-proxy"],
      ["GET", "/api/auth/expo-authorization-proxy"],
      ["GET", "/api/auth/sso/providers"],
      ["GET", "/api/auth/sso/get-provider"],
      ...[
        "register",
        "update-provider",
        "delete-provider",
        "request-domain-verification",
        "verify-domain",
      ].map((path): [string, string] => ["POST", `/api/auth/sso/${path}`]),
      ["GET", "/api/auth/sso/callback"],
      ["GET", "/api/auth/sso/callback/provider_123"],
      ["GET", "/api/auth/sso/saml2/sp/metadata"],
      ...["GET", "POST"].flatMap((method): [string, string][] => [
        [method, "/api/auth/sso/saml2/sp/acs/provider_123"],
        [method, "/api/auth/sso/saml2/sp/slo/provider_123"],
      ]),
      ["POST", "/api/auth/sso/saml2/logout/provider_123"],
    ];
    for (const [method, path] of routes)
      expect({ method, path, allowed: ownedAuthAllowed(path, method) }).toEqual(
        { method, path, allowed: true },
      );
  });

  test("does not expose provider tokens, account linking, SCIM/admin plugins, unknown auth routes or unsupported methods", () => {
    const unsupported = [
      "get-access-token",
      "refresh-token",
      "account-info",
      "list-accounts",
      "link-social",
      "unlink-account",
      "update-user",
      "delete-user",
      "update-session",
      "sign-in/email",
      "sign-up/email",
      "admin/list-users",
      "scim/v2/Users",
      "sso/new-management-route",
      "electron/unqualified-export",
      "future-plugin",
    ];
    for (const path of unsupported)
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"])
        expect(ownedAuthAllowed(`/api/auth/${path}`, method)).toBe(false);
    for (const [path, method] of [
      ["/api/auth/sso/register", "GET"],
      ["/api/auth/sso/providers", "POST"],
      ["/api/auth/sso/saml2/logout/provider", "GET"],
      ["/api/auth/sign-out", "GET"],
      ["/api/auth/desktop", "POST"],
      ["/api/auth/get-session", "DELETE"],
    ])
      expect(ownedAuthAllowed(path!, method!)).toBe(false);
    expect(ownedApiAllowed("/api/auth/get-session", "GET")).toBe(false);
    expect(ownedAuthAllowed("/api/agents", "GET")).toBe(false);
  });

  test("admits encoded identifiers without interpreting them as route structure", () => {
    for (const id of [
      "5c95a483-134f-4366-be16-fb52d9ea0d23",
      "agent%3Ascout",
      "agent%3ascout",
      "%E6%96%87%E6%A1%A3",
      "agent%20name",
    ]) {
      expect(ownedApiAllowed(`/api/agents/${id}`, "GET")).toBe(true);
      expect(ownedApiAllowed(`/api/copilotkit/agent/${id}/run`, "POST")).toBe(
        true,
      );
      expect(ownedAuthAllowed(`/api/auth/sso/callback/${id}`, "GET")).toBe(
        true,
      );
    }
  });

  test("rejects path aliases, encoded route names, separator smuggling, double encoding and URL parts", () => {
    const paths = [
      "/api//agents",
      "/api/agents/",
      "/api/agents/id/",
      "/api/%61gents",
      "/api/%61gents/id",
      "/%61pi/agents",
      "/api/agents/%69d",
      "/api/agents/.",
      "/api/agents/..",
      "/api/agents/%2e",
      "/api/agents/%2e%2e",
      "/api/agents/%252F",
      "/api/agents/a%2Fb",
      "/api/agents/a%5Cb",
      "/api/agents/a%00b",
      "/api/agents/a%0ab",
      "/api/agents/a%7fb",
      "/api/agents/a%3fb",
      "/api/agents/a%23b",
      "/api/agents/%",
      "/api/agents/%GG",
      "/api/agents/%C0%AF",
      "/api/agents/id?tenant=other",
      "/api/agents/id#other",
      "https://example.test/api/agents",
      "api/agents",
      "/api/agents\\id",
      "/api/agents\nid",
    ];
    for (const path of paths) expect(ownedApiAllowed(path, "GET")).toBe(false);
    for (const path of [
      "/api/auth/%67et-session",
      "/api/auth/get-session/",
      "/api//auth/get-session",
      "/api/auth/sso/%70roviders",
      "/api/auth/sso/callback/provider%2Fget-provider",
      "/api/auth/sso/callback/%2570roviders",
    ])
      expect(ownedAuthAllowed(path, "GET")).toBe(false);
    for (const method of [
      "get",
      "Get",
      "GET ",
      "HEAD",
      "OPTIONS",
      "TRACE",
      "CONNECT",
      "",
    ])
      expect(ownedApiAllowed("/api/agents", method)).toBe(false);
    expect(ownedApiAllowed(`/api/agents/${"a".repeat(4096)}`, "GET")).toBe(
      false,
    );
  });
});
