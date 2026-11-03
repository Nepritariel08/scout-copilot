import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OwnedOdooConnections } from "../src/components/scout/owned-odoo-connections";
import type { AgentProfile } from "../src/lib/agents/queries";
import { type AuthenticatedUser, authKeys } from "../src/lib/auth/queries";
import {
  type OwnedOdooContextStatus,
  scoutOdooKeys,
} from "../src/lib/scout-odoo";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const firstUser: AuthenticatedUser = {
  id: "owner-first",
  email: "first@fixture.example",
  role: "user",
  onboarding: null,
};
const secondUser: AuthenticatedUser = {
  ...firstUser,
  id: "owner-second",
  email: "second@fixture.example",
};
const route = {
  provider: "openrouter" as const,
  model: "synthetic-model",
  policyFingerprint: "a".repeat(64),
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const record = {
  active: true,
  credentialStored: true,
  revision: 1,
  expiresAt: "2099-01-01T00:00:00.000Z",
  projectCount: 2,
};
const release = {
  active: true,
  revision: 1,
  expiresAt: "2099-01-01T00:00:00.000Z",
  provider: "openrouter" as const,
};
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
const emptyStatus = (): OwnedOdooContextStatus => ({
  provider: "openrouter",
  route,
  record: null,
  release: null,
});
const profile = (id: string): AgentProfile => ({
  id,
  name: id === "scout" ? "Scout" : "Other Scout",
  title: "",
  roleDescription: "",
  avatarSeed: id,
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
});
const responseKey = (userId: string, agentId: string) =>
  JSON.stringify([userId, agentId]);
type Call = { path: string; method: string; body: unknown; userId: string };
let cache: QueryClient;
let actor: AuthenticatedUser;
let statuses: Map<string, OwnedOdooContextStatus>;
let denied: Set<string>;
let deniedStatus: number;
let calls: Call[];
let deferredSave: Promise<Response> | undefined;
let deferredRelease: Promise<Response> | undefined;
let deferredStatus: { key: string; response: Promise<Response> } | undefined;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  actor = firstUser;
  statuses = new Map();
  denied = new Set();
  deniedStatus = 403;
  calls = [];
  deferredSave = undefined;
  deferredRelease = undefined;
  deferredStatus = undefined;
  cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  cache.setQueryData(authKeys.currentUser(), actor);
  window.localStorage.clear();
  window.sessionStorage.clear();
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
          "http://localhost",
        );
        const method = init?.method ?? "GET";
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({
          path: url.pathname + url.search,
          method,
          body,
          userId: actor.id,
        });
        if (url.pathname === "/api/me") return Response.json({ user: actor });
        if (url.pathname === "/api/agents")
          return Response.json({
            agents: [profile("scout"), profile("other")],
          });
        if (url.pathname === "/api/scout/capabilities")
          return Response.json(catalog);
        if (url.pathname === "/api/scout/odoo/context-grants") {
          if (method === "GET") {
            const key = responseKey(
              actor.id,
              url.searchParams.get("agentId") ?? "",
            );
            if (deferredStatus?.key === key) return deferredStatus.response;
            if (denied.has(key))
              return Response.json(
                { error: "Odoo access is unavailable for this profile." },
                { status: deniedStatus },
              );
            return Response.json(statuses.get(key) ?? emptyStatus());
          }
          if (method === "POST") {
            if (deferredSave) return deferredSave;
            const key = responseKey(actor.id, "scout");
            statuses.set(key, {
              ...(statuses.get(key) ?? emptyStatus()),
              record,
            });
            return Response.json({
              revision: 1,
              projectCount: 2,
              expiresAt: record.expiresAt,
            });
          }
          if (method === "DELETE") {
            for (const [key, value] of statuses)
              if (JSON.parse(key)[0] === actor.id)
                statuses.set(key, {
                  ...value,
                  record: value.record
                    ? {
                        ...value.record,
                        active: false,
                        credentialStored: false,
                      }
                    : null,
                  release: null,
                });
            return Response.json({ revoked: true });
          }
        }
        if (url.pathname === "/api/scout/odoo/context-grants/release") {
          if (deferredRelease) return deferredRelease;
          const key = responseKey(actor.id, body.agentId);
          const value = statuses.get(key) ?? emptyStatus();
          statuses.set(key, {
            ...value,
            release: method === "POST" ? release : null,
          });
          return Response.json({ revision: 1, revoked: method === "DELETE" });
        }
        return Response.json(
          { error: "Unexpected synthetic request." },
          { status: 500 },
        );
      },
      { preconnect: () => undefined },
    ),
  );
});

afterEach(async () => {
  cleanup();
  cache.clear();
  await settleReactWork();
  fetchSpy.mockRestore();
});

function mount() {
  return render(
    <QueryClientProvider client={cache}>
      <OwnedOdooConnections />
    </QueryClientProvider>,
  );
}

async function select(view: ReturnType<typeof mount>, value = "scout") {
  const field = await view.findByLabelText("Scout profile");
  fireEvent.change(field, { target: { value } });
}

const mutations = () => calls.filter((call) => call.method !== "GET");

test("Connections saves the one-shot Odoo key through the existing API without selecting or sending a task", async () => {
  const view = mount();
  await select(view);
  const field = (await view.findByLabelText(
    "Odoo API key",
  )) as HTMLInputElement;
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(field, "synthetic-connection-key");
  await user.click(view.getByRole("button", { name: "Save Odoo access key" }));
  await view.findByText("Scout saved an encrypted Odoo credential.");
  expect(field.value).toBe("");
  expect(mutations()).toEqual([
    {
      path: "/api/scout/odoo/context-grants",
      method: "POST",
      body: { apiKey: "synthetic-connection-key" },
      userId: firstUser.id,
    },
  ]);
  expect(view.queryByLabelText("Odoo project task ID")).toBeNull();
  expect(view.queryByRole("button", { name: "Use task once" })).toBeNull();
  expect(view.queryByRole("button", { name: /^Send|Submit.*DSH/ })).toBeNull();
  expect(view.getAllByText("Not connected")).toHaveLength(7);
  expect(
    calls.some((call) =>
      /\/api\/(?:plugins|auth\/.*oauth|scout\/tasks|copilotkit)/.test(
        call.path,
      ),
    ),
  ).toBe(false);
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
  expect(JSON.stringify(cache.getQueryCache().getAll())).not.toContain(
    "synthetic-connection-key",
  );
});

test("profile consent, withdrawal and account revoke use the original route challenge and expiry", async () => {
  statuses.set(responseKey(actor.id, "scout"), { ...emptyStatus(), record });
  const view = mount();
  await select(view);
  await view.findByText(
    /Model sharing: not allowed to OpenRouter, model synthetic-model/,
  );
  fireEvent.click(
    view.getByRole("button", {
      name: "Allow task summaries to reach this model",
    }),
  );
  await view.findByRole("button", { name: "Withdraw model-sharing consent" });
  expect(mutations()[0]?.body).toEqual({
    agentId: "scout",
    consent: true,
    expectedProvider: "openrouter",
    expectedModel: route.model,
    expectedPolicyFingerprint: route.policyFingerprint,
  });
  expect(statuses.get(responseKey(actor.id, "scout"))?.record?.expiresAt).toBe(
    record.expiresAt,
  );
  fireEvent.click(
    view.getByRole("button", { name: "Withdraw model-sharing consent" }),
  );
  await view.findByText(/Model sharing: not allowed/);
  expect(mutations()[1]).toMatchObject({
    path: "/api/scout/odoo/context-grants/release",
    method: "DELETE",
    body: { agentId: "scout" },
  });
  fireEvent.click(
    view.getByRole("button", { name: "Revoke Scout's Odoo access" }),
  );
  await view.findByText(
    /Scout's local Odoo grant and provider consent were revoked/,
  );
  expect(mutations()[2]).toMatchObject({
    path: "/api/scout/odoo/context-grants",
    method: "DELETE",
    body: undefined,
  });
});

test.each([403, 404])(
  "a refused profile (%i) stays selected and never falls back to another grant",
  async (statusCode) => {
    deniedStatus = statusCode;
    denied.add(responseKey(actor.id, "other"));
    statuses.set(responseKey(actor.id, "scout"), {
      ...emptyStatus(),
      record,
      release,
    });
    const view = mount();
    await select(view, "other");
    await view.findByText("Odoo access is unavailable for this profile.");
    expect(
      (view.getByLabelText("Scout profile") as HTMLSelectElement).value,
    ).toBe("other");
    expect(view.queryByLabelText("Odoo API key")).toBeNull();
    expect(view.queryByText(/Odoo access: active/)).toBeNull();
    expect(
      calls.filter((call) =>
        call.path.startsWith("/api/scout/odoo/context-grants"),
      ),
    ).toHaveLength(1);
    expect(mutations()).toHaveLength(0);
  },
);

test("a late sharing-consent result is discarded after the native account changes", async () => {
  let resolve!: (response: Response) => void;
  deferredRelease = new Promise<Response>((done) => {
    resolve = done;
  });
  statuses.set(responseKey(firstUser.id, "scout"), {
    ...emptyStatus(),
    record,
  });
  const view = mount();
  await select(view);
  fireEvent.click(
    await view.findByRole("button", {
      name: "Allow task summaries to reach this model",
    }),
  );
  await waitFor(() => expect(mutations()).toHaveLength(1));
  actor = secondUser;
  cache.setQueryData(authKeys.currentUser(), actor);
  await waitFor(() =>
    expect(
      (view.getByLabelText("Scout profile") as HTMLSelectElement).value,
    ).toBe(""),
  );
  await select(view);
  await view.findByText("Odoo access: not active");
  resolve(Response.json({ revision: 1, provider: "openrouter" }));
  await settleReactWork();
  expect(view.queryByText("Model-sharing consent recorded.")).toBeNull();
  expect(
    view.queryByRole("button", { name: "Withdraw model-sharing consent" }),
  ).toBeNull();
  expect(mutations().every((call) => call.userId === firstUser.id)).toBe(true);
});

test("an older profile status cannot replace the newly selected profile", async () => {
  let resolve!: (response: Response) => void;
  deferredStatus = {
    key: responseKey(actor.id, "scout"),
    response: new Promise<Response>((done) => {
      resolve = done;
    }),
  };
  statuses.set(responseKey(actor.id, "other"), {
    ...emptyStatus(),
    provider: "local",
    route: { ...route, provider: "local", model: "second-profile-model" },
  });
  const view = mount();
  await select(view);
  await view.findByText("Loading Odoo access…");
  await select(view, "other");
  await view.findByText(/model second-profile-model/);
  resolve(Response.json({ ...emptyStatus(), record, release }));
  await settleReactWork();
  expect(view.queryByText(/model synthetic-model/)).toBeNull();
  expect(view.queryByText(/Odoo access: active/)).toBeNull();
});

test("a late key-save result is discarded after switching profile", async () => {
  let resolve!: (response: Response) => void;
  deferredSave = new Promise<Response>((done) => {
    resolve = done;
  });
  const view = mount();
  await select(view);
  const field = (await view.findByLabelText(
    "Odoo API key",
  )) as HTMLInputElement;
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(field, "synthetic-pending-key");
  await user.click(view.getByRole("button", { name: "Save Odoo access key" }));
  await waitFor(() => expect(mutations()).toHaveLength(1));
  await select(view, "other");
  await view.findByLabelText("Odoo API key");
  resolve(
    Response.json({
      revision: 1,
      projectCount: 2,
      expiresAt: record.expiresAt,
    }),
  );
  await settleReactWork();
  expect(
    view.queryByText("Scout saved an encrypted Odoo credential."),
  ).toBeNull();
  expect((view.getByLabelText("Odoo API key") as HTMLInputElement).value).toBe(
    "",
  );
  expect(
    calls.filter((call) => call.path.endsWith("?agentId=scout")),
  ).toHaveLength(1);
});

test("switching the native account discards the former profile and credential field", async () => {
  statuses.set(responseKey(firstUser.id, "scout"), {
    ...emptyStatus(),
    record,
    release,
  });
  const view = mount();
  await select(view);
  await view.findByText(/Odoo access: active/);
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(view.getByLabelText("Odoo API key"), "synthetic-unsent-key");
  actor = secondUser;
  cache.setQueryData(authKeys.currentUser(), actor);
  await waitFor(() =>
    expect(
      (view.getByLabelText("Scout profile") as HTMLSelectElement).value,
    ).toBe(""),
  );
  expect(view.queryByLabelText("Odoo API key")).toBeNull();
  await select(view);
  await view.findByText("Odoo access: not active");
  expect((view.getByLabelText("Odoo API key") as HTMLInputElement).value).toBe(
    "",
  );
  expect(view.queryByText(/Odoo access: active/)).toBeNull();
  expect(mutations()).toHaveLength(0);
  expect(
    calls.some(
      (call) => call.path === "/api/agents" && call.userId === secondUser.id,
    ),
  ).toBe(true);
});

test("a denied refresh removes cached access and sharing controls without changing the profile", async () => {
  statuses.set(responseKey(actor.id, "scout"), {
    ...emptyStatus(),
    record,
    release,
  });
  const view = mount();
  await select(view);
  await view.findByText(/Odoo access: active/);
  denied.add(responseKey(actor.id, "scout"));
  await cache.invalidateQueries({ queryKey: scoutOdooKeys(actor.id, "scout") });
  await view.findByText("Odoo access is unavailable for this profile.");
  expect(view.queryByText(/Odoo access: active/)).toBeNull();
  expect(
    view.queryByRole("button", { name: "Withdraw model-sharing consent" }),
  ).toBeNull();
  expect(view.queryByLabelText("Odoo API key")).toBeNull();
  expect(
    (view.getByLabelText("Scout profile") as HTMLSelectElement).value,
  ).toBe("scout");
  expect(mutations()).toHaveLength(0);
});

test("expired stored access remains revocable and refresh never renews a grant", async () => {
  const expired = { ...record, expiresAt: "2000-01-01T00:00:00Z" };
  statuses.set(responseKey(actor.id, "scout"), {
    ...emptyStatus(),
    record: expired,
    release: { ...release, expiresAt: expired.expiresAt },
  });
  const view = mount();
  await select(view);
  await view.findByText(/Odoo access: not active/);
  expect(
    view.getByRole("button", { name: "Revoke Scout's Odoo access" }),
  ).toBeTruthy();
  expect(
    view.queryByRole("button", {
      name: "Allow task summaries to reach this model",
    }),
  ).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Refresh Odoo access" }));
  await view.findByText("Odoo access refreshed.");
  expect(statuses.get(responseKey(actor.id, "scout"))?.record?.expiresAt).toBe(
    expired.expiresAt,
  );
  expect(mutations()).toHaveLength(0);
});
