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
import type { ScoutTaskView } from "@openbot/shared/scout";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScoutDrafts } from "../src/components/scout/drafts";
import { type AuthenticatedUser, authKeys } from "../src/lib/auth/queries";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const alice: AuthenticatedUser = {
  id: "alice",
  email: "alice@fixture.example",
  role: "user",
  onboarding: null,
};
const bob: AuthenticatedUser = { ...alice, id: "bob" };
const base: ScoutTaskView = {
  id: "2ecf8b91-103c-4c24-93ca-623046bc6887",
  channelId: "conversation",
  sourceId: "3b7bd5d5-cbb1-484d-8293-26f5903d1442",
  title: "Fixture draft",
  state: "review_required",
  workItemId: 1,
  revision: 3,
  result: "<img src=x onerror='privateData()'>",
  draftDigest: "a".repeat(64),
  accepted: false,
  errorCode: null,
  updatedAt: "2026-11-01T00:00:00Z",
};
let cache: QueryClient;
let view: ReturnType<typeof render>;
let current = alice;
let tasks: ScoutTaskView[] = [];
let calls: { path: string; body: Record<string, unknown> }[] = [];
let failSubmit = false;
let denied = false;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  cache.setQueryData(authKeys.currentUser(), alice);
  current = alice;
  tasks = [];
  calls = [];
  failSubmit = false;
  denied = false;
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
        if (url.pathname === "/api/me") return Response.json({ user: current });
        if (url.pathname === "/api/scout/tasks" && !init?.body) {
          if (denied)
            return Response.json({ error: "Access revoked." }, { status: 403 });
          return Response.json({ tasks });
        }
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : {};
        calls.push({ path: url.pathname, body });
        if (url.pathname === "/api/scout/tasks") {
          const item = {
            ...base,
            state: "queued" as const,
            result: null,
            draftDigest: null,
            sourceId: String(body.sourceId),
          };
          tasks = [item];
          if (failSubmit) {
            tasks[0].state = "submission_unknown";
            return Response.json(
              { error: "Submission unconfirmed. Recover the existing task." },
              { status: 503 },
            );
          }
          return Response.json({ task: item });
        }
        if (url.pathname === `/api/scout/tasks/${base.id}`) {
          if (body.action === "accept")
            tasks = [
              { ...base, state: "completed", accepted: true, revision: 4 },
            ];
          if (body.action === "cancel")
            tasks = [
              { ...base, state: "cancelled", result: null, revision: 4 },
            ];
          if (body.action === "recover")
            tasks = [{ ...base, state: "queued", result: null }];
          return Response.json({ task: tasks[0] });
        }
        return Response.json(
          { error: "Unexpected fixture endpoint." },
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
  view = render(
    <QueryClientProvider client={cache}>
      <ScoutDrafts channelId="conversation" />
    </QueryClientProvider>,
  );
  fireEvent.click(view.getByText("Delegated drafts"));
}
async function submit() {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(await view.findByLabelText("Draft title"), "Requested draft");
  await user.type(
    view.getByLabelText("Instructions and permitted context"),
    "Draft my synthetic summary.",
  );
  await user.click(view.getByRole("button", { name: "Delegate draft" }));
}

test("delegating sends one explicit queue request with a stable nonce, without a chat/model turn", async () => {
  mount();
  await submit();
  await view.findByText("Queued");
  expect(calls).toHaveLength(1);
  expect(calls[0].body).toMatchObject({
    channelId: "conversation",
    title: "Requested draft",
    instructions: "Draft my synthetic summary.",
  });
  expect(typeof calls[0].body.sourceId).toBe("string");
  expect(JSON.stringify(calls)).not.toContain("copilotkit");
  cleanup();
  expect(calls.filter((call) => call.body.action === "cancel")).toHaveLength(0);
});

test("an uncertain submission exposes recovery and preserves the original retry nonce", async () => {
  failSubmit = true;
  mount();
  await submit();
  await view.findByText("Submission unconfirmed. Recover the existing task.");
  await view.findByRole("button", { name: "Recover submission" });
  fireEvent.click(view.getByRole("button", { name: "Delegate draft" }));
  await waitFor(() =>
    expect(
      calls.filter((call) => call.path === "/api/scout/tasks"),
    ).toHaveLength(2),
  );
  expect(calls[1].body.sourceId).toBe(calls[0].body.sourceId);
  fireEvent.click(view.getByRole("button", { name: "Recover submission" }));
  await view.findByText("Queued");
  expect(calls.filter((call) => call.body.action === "recover")).toHaveLength(
    1,
  );
});

test("draft text stays inert and acceptance names the displayed revision and digest", async () => {
  tasks = [base];
  mount();
  await view.findByText(base.result ?? "");
  expect(document.querySelector("img")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Accept draft" }));
  await view.findByText("Accepted");
  expect(calls[0].body).toEqual({
    action: "accept",
    revision: 3,
    draftDigest: "a".repeat(64),
  });
  expect(view.queryByRole("button", { name: "Accept draft" })).toBeNull();
});

test("switching accounts cannot reuse another user's cached draft or form nonce", async () => {
  tasks = [base];
  mount();
  await view.findByText(base.result ?? "");
  current = bob;
  denied = true;
  cache.setQueryData(authKeys.currentUser(), bob);
  await view.findByText("Access revoked.");
  expect(view.queryByText(base.result ?? "")).toBeNull();
  expect(view.queryByRole("button", { name: "Accept draft" })).toBeNull();
});

test("a failed draft retains explicit revision-bound cancellation", async () => {
  tasks = [{ ...base, state: "failed", result: null }];
  mount();
  fireEvent.click(await view.findByRole("button", { name: "Cancel task" }));
  await view.findByText("Cancelled");
  expect(calls[0].body).toEqual({ action: "cancel", revision: 3 });
});
