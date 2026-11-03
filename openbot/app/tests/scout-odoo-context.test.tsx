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
import { useState } from "react";
import { ScoutOdooContext } from "../src/components/scout/odoo-context";
import { type AuthenticatedUser, authKeys } from "../src/lib/auth/queries";
import {
  consentOdooContextRelease,
  type OwnedOdooContextStatus,
  withOdooTaskSelection,
} from "../src/lib/scout-odoo";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const owner: AuthenticatedUser = {
  id: "employee-1",
  email: "employee@fixture.example",
  role: "user",
  onboarding: null,
};
const activeRoute = {
  provider: "openrouter" as const,
  model: "synthetic-model",
  policyFingerprint: "a".repeat(64),
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const activeRecord = {
  active: true,
  credentialStored: true,
  revision: 1,
  expiresAt: "2099-01-01T00:00:00.000Z",
  projectCount: 4,
};
const activeRelease = {
  active: true,
  revision: 1,
  expiresAt: "2099-01-01T00:00:00.000Z",
  provider: "openrouter" as const,
};
let cache: QueryClient;
let status: OwnedOdooContextStatus;
let calls: { path: string; method: string; body: unknown }[];
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let rotateOnConsent = false;

beforeEach(() => {
  rotateOnConsent = false;
  cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  cache.setQueryData(authKeys.currentUser(), owner);
  status = {
    route: activeRoute,
    provider: "openrouter",
    record: null,
    release: null,
  };
  calls = [];
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
        if (url.pathname === "/api/me") return Response.json({ user: owner });
        if (url.pathname === "/api/scout/odoo/context-grants" && !init?.method)
          return Response.json(status);
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ path: url.pathname, method: init?.method ?? "GET", body });
        if (
          url.pathname === "/api/scout/odoo/context-grants" &&
          init?.method === "POST"
        ) {
          status = { ...status, record: activeRecord };
          return Response.json({ revision: 1, projectCount: 4 });
        }
        if (url.pathname.endsWith("/release") && init?.method === "POST") {
          if (rotateOnConsent) {
            status = {
              ...status,
              provider: "local",
              route: {
                ...activeRoute,
                provider: "local",
                model: "new-local-model",
                policyFingerprint: "b".repeat(64),
              },
              release: null,
            };
            return Response.json({ code: "MODEL_CONFLICT" }, { status: 409 });
          }
          status = {
            ...status,
            release: { ...activeRelease, provider: status.provider },
          };
          return Response.json({ revision: 1, provider: "openrouter" });
        }
        if (url.pathname.endsWith("/release") && init?.method === "DELETE") {
          status = { ...status, release: { ...activeRelease, active: false } };
          return Response.json({ revoked: true });
        }
        if (
          url.pathname === "/api/scout/odoo/context-grants" &&
          init?.method === "DELETE"
        ) {
          status = {
            ...status,
            record: status.record
              ? { ...status.record, active: false, credentialStored: false }
              : null,
            release: status.release
              ? { ...status.release, active: false }
              : null,
          };
          return Response.json({ revoked: true });
        }
        return Response.json(
          { error: "Unexpected fixture request." },
          { status: 500 },
        );
      },
      { preconnect: () => undefined },
    ),
  );
});

afterEach(() => {
  cleanup();
  cache.clear();
  fetchSpy?.mockRestore();
});

function mount() {
  const view = render(
    <QueryClientProvider client={cache}>
      <ScoutOdooContext
        agentId="scout"
        selectedTaskId={null}
        contextTaskId={null}
        onSelectTaskId={() => undefined}
        busy={false}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(view.getByText("Odoo context"));
  return view;
}

test("the one-shot Odoo key is sent once and cleared without browser storage", async () => {
  const view = mount();
  await view.findByText("Odoo access: not active");
  const user = userEvent.setup({ document: view.container.ownerDocument });
  const field = view.getByLabelText("Odoo API key") as HTMLInputElement;
  await user.type(field, "synthetic-odoo-api-key");
  await user.click(view.getByRole("button", { name: "Save Odoo access key" }));
  await waitFor(() => expect(field.value).toBe(""));
  await view.findByText(/Odoo access: active/);
  expect(calls).toContainEqual({
    path: "/api/scout/odoo/context-grants",
    method: "POST",
    body: { apiKey: "synthetic-odoo-api-key" },
  });
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
  expect(JSON.stringify(cache.getQueryCache().getAll())).not.toContain(
    "synthetic-odoo-api-key",
  );
});

test("model-release controls use the server-selected provider and can be withdrawn", async () => {
  status = {
    route: activeRoute,
    provider: "openrouter",
    record: activeRecord,
    release: null,
  };
  const view = mount();
  await view.findByText(/Model sharing: not allowed to OpenRouter/);
  fireEvent.click(
    view.getByRole("button", {
      name: "Allow task summaries to reach this model",
    }),
  );
  await view.findByRole("button", { name: "Withdraw model-sharing consent" });
  expect(calls[0]).toEqual({
    path: "/api/scout/odoo/context-grants/release",
    method: "POST",
    body: {
      agentId: "scout",
      consent: true,
      expectedProvider: activeRoute.provider,
      expectedModel: activeRoute.model,
      expectedPolicyFingerprint: activeRoute.policyFingerprint,
    },
  });
  fireEvent.click(
    view.getByRole("button", { name: "Withdraw model-sharing consent" }),
  );
  await view.findByText(/Model sharing: not allowed to OpenRouter/);
  expect(calls[1]).toEqual({
    path: "/api/scout/odoo/context-grants/release",
    method: "DELETE",
    body: { agentId: "scout" },
  });
});

test("a changed route is refreshed for review without retrying consent automatically", async () => {
  status = {
    provider: "openrouter",
    route: activeRoute,
    record: activeRecord,
    release: null,
  };
  rotateOnConsent = true;
  const view = mount();
  await view.findByText(/model synthetic-model/);
  fireEvent.click(
    view.getByRole("button", {
      name: "Allow task summaries to reach this model",
    }),
  );
  await view.findByText(/model new-local-model/);
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(calls[0]?.body).toEqual({
    agentId: "scout",
    consent: true,
    expectedProvider: "openrouter",
    expectedModel: "synthetic-model",
    expectedPolicyFingerprint: activeRoute.policyFingerprint,
  });
  expect(view.queryByText("Model-sharing consent recorded.")).toBeNull();
  rotateOnConsent = false;
  fireEvent.click(
    view.getByRole("button", {
      name: "Allow task summaries to reach this model",
    }),
  );
  await view.findByText("Model-sharing consent recorded.");
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
  expect(calls[1]?.body).toEqual({
    agentId: "scout",
    consent: true,
    expectedProvider: "local",
    expectedModel: "new-local-model",
    expectedPolicyFingerprint: "b".repeat(64),
  });
});

test("missing or expired status challenges cannot enable consent and expired helper calls make no request", async () => {
  for (const route of [
    undefined,
    { ...activeRoute, expiresAt: "2000-01-01T00:00:00Z" },
  ]) {
    status = {
      provider: "openrouter",
      route,
      record: activeRecord,
      release: null,
    } as OwnedOdooContextStatus;
    const view = mount();
    await view.findByText(/Odoo access: active/);
    expect(
      (
        view.getByRole("button", {
          name: "Allow task summaries to reach this model",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    cleanup();
    cache.clear();
    cache.setQueryData(authKeys.currentUser(), owner);
  }
  await expect(
    consentOdooContextRelease("scout", {
      ...activeRoute,
      expiresAt: "2000-01-01T00:00:00Z",
    }),
  ).rejects.toThrow("model route expired");
  expect(calls).toHaveLength(0);
});

test("the rendered status contains no credential reference and task selection requires both grants", async () => {
  status = {
    route: activeRoute,
    provider: "openrouter",
    record: { ...activeRecord, credentialRef: "must-not-render" } as never,
    release: activeRelease,
  };
  const view = mount();
  await view.findByText(/Odoo access: active/);
  expect(view.queryByText("must-not-render")).toBeNull();
  const taskId = view.getByLabelText("Odoo project task ID");
  expect((taskId as HTMLInputElement).disabled).toBe(false);
});

test("expired record access keeps a revoke action while its key remains stored", async () => {
  status = {
    route: activeRoute,
    provider: "openrouter",
    record: {
      ...activeRecord,
      active: false,
      expiresAt: "2020-01-01T00:00:00.000Z",
    },
    release: null,
  };
  const view = mount();
  await view.findByText(/Odoo access: not active/);
  expect(
    view.getByRole("button", { name: "Revoke Scout's Odoo access" }),
  ).toBeTruthy();
});

test("revoking the stored key removes the revoke action after status refresh", async () => {
  status = {
    route: activeRoute,
    provider: "openrouter",
    record: activeRecord,
    release: null,
  };
  const view = mount();
  const button = await view.findByRole("button", {
    name: "Revoke Scout's Odoo access",
  });
  fireEvent.click(button);
  await view.findByText(
    "Scout's local Odoo grant and provider consent were revoked. The upstream Odoo API key remains valid until you revoke it in Odoo.",
  );
  expect(calls).toContainEqual({
    path: "/api/scout/odoo/context-grants",
    method: "DELETE",
    body: undefined,
  });
  await waitFor(() =>
    expect(
      view.queryByRole("button", { name: "Revoke Scout's Odoo access" }),
    ).toBeNull(),
  );
});

test("the selected task marker is removed after successful or failed runs", async () => {
  const removed: string[] = [];
  const added: unknown[] = [];
  const host = {
    addContext(value: unknown) {
      added.push(value);
      return "context-1";
    },
    removeContext(id: string) {
      removed.push(id);
    },
  };
  await expect(
    withOdooTaskSelection(host, "channel:one", "77", async () => "ok"),
  ).resolves.toBe("ok");
  expect(added[0]).toEqual({
    description: "scout.project_task_id",
    value: "77",
    agentIds: ["channel:one"],
  });
  expect(removed).toEqual(["context-1"]);
  await expect(
    withOdooTaskSelection(host, "channel:one", "77", async () => {
      throw new Error("synthetic run failure");
    }),
  ).rejects.toThrow("synthetic run failure");
  expect(removed).toEqual(["context-1", "context-1"]);
  await expect(
    withOdooTaskSelection(host, "channel:one", "0077", async () => "unused"),
  ).rejects.toThrow("valid Odoo task ID");
});

test.each(["account", "profile"] as const)(
  "chat preserves its initial selected intent and clears it on a native %s transition",
  async (transition) => {
    status = {
      route: activeRoute,
      provider: "openrouter",
      record: activeRecord,
      release: activeRelease,
    };
    const selected: (string | null)[] = [];
    function ParentChat({ agentId }: { agentId: string }) {
      const [taskId, setTaskId] = useState<string | null>("77");
      return (
        <>
          <output aria-label="Next chat task">{taskId ?? "none"}</output>
          <ScoutOdooContext
            agentId={agentId}
            selectedTaskId={taskId}
            contextTaskId={null}
            onSelectTaskId={(next) => {
              selected.push(next);
              setTaskId(next);
            }}
            busy={false}
          />
        </>
      );
    }
    const chat = (agentId: string) => (
      <QueryClientProvider client={cache}>
        <ParentChat agentId={agentId} />
      </QueryClientProvider>
    );
    const view = render(chat("scout"));
    fireEvent.click(view.getByText("Odoo context"));
    await view.findByText(/Odoo project task #77 is queued/);
    expect(view.getByLabelText("Next chat task").textContent).toBe("77");
    expect(selected).toEqual([]);
    view.rerender(chat("scout"));
    await settleReactWork();
    expect(selected).toEqual([]);
    if (transition === "account") {
      cache.setQueryData(authKeys.currentUser(), {
        ...owner,
        id: "employee-2",
        email: "second@fixture.example",
      });
    } else {
      view.rerender(chat("other-profile"));
    }
    await waitFor(() =>
      expect(view.getByLabelText("Next chat task").textContent).toBe("none"),
    );
    expect(selected).toEqual([null]);
    expect(view.queryByText(/Odoo project task #77 is queued/)).toBeNull();
    expect(calls).toEqual([]);
  },
);
