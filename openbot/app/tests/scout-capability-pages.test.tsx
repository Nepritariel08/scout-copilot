import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { Route as SkillsRoute } from "@/routes/_authed/_app/capabilities.skills";
import { Route as ConnectionsRoute } from "@/routes/_authed/_app/connections.index";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const catalog = {
  version: 1,
  skills: {
    conversation: "available",
    odooSelectedTask: "requires_authorization",
    delegatedDraft: "requires_authorization",
  },
  integrations: {
    outlookCalendar: "not_connected",
    outlookEmail: "not_connected",
    teams: "not_connected",
    sharePoint: "not_connected",
    googleDrive: "not_connected",
    github: "not_connected",
    fireflies: "not_connected",
  },
  voice: "unavailable",
  modelTools: "protected_policy_opt_in",
};

function screen(
  route: typeof SkillsRoute | typeof ConnectionsRoute,
  response: () => Response,
) {
  const requested: string[] = [];
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input);
      requested.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/agents") return Response.json({ agents: [] });
      if (path !== "/api/scout/capabilities")
        throw new Error(`Unexpected legacy or external request: ${path}`);
      return response();
    },
    { preconnect: originalFetch.preconnect },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), { mode: "owned" });
  client.setQueryData(authKeys.currentUser(), {
    id: "fixture-owner",
    email: "owner@fixture.example",
    role: "user",
    onboarding: null,
  });
  const Component = route.options.component as ComponentType;
  const view = render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
  return { view, client, requested };
}

const json = (value: unknown) => Response.json(value);

test("owned Skills uses the authorized catalog without querying unavailable plugin management", async () => {
  const { view, requested } = screen(SkillsRoute, () => json(catalog));
  await view.findByText("Saved conversations");
  expect(view.getAllByText("Authorization required")).toHaveLength(2);
  expect(view.getByText(/Custom skill installation.*not enabled/)).toBeTruthy();
  expect(view.queryByRole("button", { name: "New skill" })).toBeNull();
  expect(requested).toEqual(["GET /api/scout/capabilities"]);
});

test("an installed speech backend does not advertise deferred voice as available", async () => {
  const { view } = screen(SkillsRoute, () =>
    json({ ...catalog, voice: "push_to_talk" }),
  );
  await view.findByText("Voice");
  expect(view.getByText("Deferred")).toBeTruthy();
  expect(view.queryByText("Hands-free voice and read aloud")).toBeNull();
  expect(view.getByText("Saved conversations")).toBeTruthy();
});

test("owned Connections offers Odoo setup while seven other accounts remain disconnected", async () => {
  const { view, requested } = screen(ConnectionsRoute, () => json(catalog));
  await view.findByText("Microsoft Teams");
  expect(view.getAllByText("Not connected")).toHaveLength(7);
  expect(
    view.getByText(/Connections in ChatGPT do not carry over/),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: /^Connect/ })).toBeNull();
  expect(new Set(requested)).toEqual(
    new Set(["GET /api/agents", "GET /api/scout/capabilities"]),
  );
  expect(
    view.getByText(
      "No built-in Scout profiles are available for this account.",
    ),
  ).toBeTruthy();
});

test("an unrecognized catalog never becomes an available capability", async () => {
  const { view } = screen(SkillsRoute, () =>
    json({
      ...catalog,
      skills: { ...catalog.skills, odooSelectedTask: "owner" },
    }),
  );
  await view.findByRole("alert");
  expect(view.queryByText("Available")).toBeNull();
  expect(view.getByText(/Connection status is unverified/)).toBeTruthy();
});

test("a denied catalog refresh removes cached availability instead of presenting stale access", async () => {
  let denied = false;
  const { view, client } = screen(SkillsRoute, () =>
    denied ? new Response(null, { status: 401 }) : json(catalog),
  );
  await view.findByText("Saved conversations");
  denied = true;
  await client.invalidateQueries({ queryKey: ["scout", "capability-catalog"] });
  await view.findByRole("alert");
  expect(view.queryByText("Available")).toBeNull();
  const retry = view.getByRole("button", { name: "Retry check" });
  fireEvent.click(retry);
  await waitFor(() =>
    expect(client.getQueryState(["scout", "capability-catalog"])?.status).toBe(
      "error",
    ),
  );
});
