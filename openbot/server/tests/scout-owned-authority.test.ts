import { describe, expect, test } from "bun:test";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { ChannelStore } from "../src/channels/routes";
import { parseScoutMembership } from "../src/scout/membership";
import { createOwnedAuthority } from "../src/scout/owned/authority";
import { membershipFixture } from "./scout-membership.test";

type Profile = NonNullable<Awaited<ReturnType<AgentProfileStore["get"]>>>;
type Channel = NonNullable<Awaited<ReturnType<ChannelStore["get"]>>>;
function fixture() {
  const config = membershipFixture();
  let afterProfile = () => {},
    afterChannel = () => {};
  const authority = createOwnedAuthority({
    auth: {
      handler: () => new Response(null),
      api: {
        getSession: async ({ query }) => {
          expect(query?.disableCookieCache).toBe(true);
          return {
            user: {
              id: "scout-fixture-alice",
              email: "synthetic@fixture.invalid",
              role: "user",
            },
          };
        },
      },
    },
    roles: { rolesForUser: async () => ["user"] },
    binding: async (actor) => parseScoutMembership(config, actor, "scout-test"),
    profiles: {
      get: async () => {
        afterProfile();
        return {} as Profile;
      },
    },
    channels: {
      get: async () => {
        afterChannel();
        return { agentIds: ["fixture"], threadId: "thread" } as Channel;
      },
    },
  });
  return {
    config,
    authority,
    history: authority.forRequest(new Request("https://scout.fixture.example")),
    afterProfile: (work: () => void) => {
      afterProfile = work;
    },
    afterChannel: (work: () => void) => {
      afterChannel = work;
    },
  };
}
describe("native history pins current membership throughout awaited authorization", () => {
  test("an owned history resource cannot silently omit the provenance authority", async () => {
    const f = fixture();
    const principal = await f.history.principal();
    await expect(
      f.history.authorizeContext!(principal!, {
        id: "thread",
        agentId: "fixture",
        channelId: null,
      }),
    ).rejects.toThrow("HISTORY_ACCESS_DENIED");
  });
  test("same-tenant revision during profile lookup withholds a history grant", async () => {
    const f = fixture(),
      principal = await f.history.principal();
    f.afterProfile(() => {
      f.config.memberships[0].revision++;
    });
    await expect(
      f.history.authorize(
        principal!,
        { agentId: "fixture", channelId: null },
        "read",
      ),
    ).rejects.toThrow("HISTORY_ACCESS_DENIED");
  });
  test("revision during channel lookup cannot grant a captured history request", async () => {
    const f = fixture(),
      principal = await f.history.principal();
    f.afterChannel(() => {
      f.config.memberships[0].revision++;
    });
    await expect(
      f.history.authorize(
        principal!,
        { id: "thread", agentId: "fixture", channelId: "channel" },
        "read",
      ),
    ).rejects.toThrow("HISTORY_ACCESS_DENIED");
  });
  test("a new request can use a refreshed membership while the old request remains fenced", async () => {
    const f = fixture();
    expect(await f.history.principal()).toEqual({
      userId: "scout-fixture-alice",
      tenantId: "tenant-a",
    });
    f.config.memberships[0].revision++;
    await expect(f.history.principal()).rejects.toThrow(
      "HISTORY_ACCESS_DENIED",
    );
    expect(
      await f.authority
        .forRequest(new Request("https://scout.fixture.example"))
        .principal(),
    ).toEqual({ userId: "scout-fixture-alice", tenantId: "tenant-a" });
  });
});
