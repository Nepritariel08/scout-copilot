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
import { act } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  botThreadKey,
  useBotThreadState as useBotThread,
} from "../src/lib/copilot/bot-thread-state";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let reply: (path: string) => Promise<Response>;
let calls: string[];
beforeEach(() => {
  window.localStorage.clear();
  calls = [];
  reply = async () => Response.json({ threadId: "minted-by-server" });
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const path = String(input);
        calls.push(path);
        return reply(path);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
});
afterEach(async () => {
  cleanup();
  await settleReactWork();
  fetchSpy.mockRestore();
});
function Chat({
  ownerId = "alice",
  enabled = true,
}: {
  ownerId?: string;
  enabled?: boolean;
}) {
  const result = useBotThread("scout", {
    ownerId,
    enabled,
    requireServerMint: true,
  });
  return (
    <>
      <output data-testid="thread">{result.threadId ?? "none"}</output>
      <output data-testid="history">{result.history}</output>
      <button type="button" onClick={result.startNew}>
        New chat
      </button>
    </>
  );
}
test("owned chat cannot invent an unowned browser thread when server mint fails", async () => {
  reply = async () => new Response(null, { status: 503 });
  const view = render(<Chat />);
  await waitFor(() =>
    expect(view.getByTestId("history").textContent).toBe("unavailable"),
  );
  expect(view.getByTestId("thread").textContent).toBe("none");
  expect(
    window.localStorage.getItem(botThreadKey("scout", "alice")),
  ).toBeNull();
  reply = async () => Response.json({ threadId: "owned-retry" });
  fireEvent.click(view.getByRole("button", { name: "New chat" }));
  await waitFor(() =>
    expect(view.getByTestId("thread").textContent).toBe("owned-retry"),
  );
});
test("the current native user gets a separate storage slot and late prior-user mint cannot replace it", async () => {
  let late!: (response: Response) => void;
  reply = async () => Response.json({ threadId: "alice-owned-thread" });
  const view = render(<Chat />);
  await waitFor(() =>
    expect(view.getByTestId("thread").textContent).toBe("alice-owned-thread"),
  );
  reply = async () =>
    new Promise<Response>((resolve) => {
      late = resolve;
    });
  fireEvent.click(view.getByRole("button", { name: "New chat" }));
  await waitFor(() => expect(calls).toHaveLength(2));
  reply = async () => Response.json({ threadId: "bob-owned-thread" });
  view.rerender(<Chat ownerId="bob" />);
  await waitFor(() =>
    expect(view.getByTestId("thread").textContent).toBe("bob-owned-thread"),
  );
  await act(async () => late(Response.json({ threadId: "alice-late-thread" })));
  expect(view.getByTestId("thread").textContent).toBe("bob-owned-thread");
  expect(window.localStorage.getItem(botThreadKey("scout", "alice"))).toBe(
    "alice-owned-thread",
  );
  expect(window.localStorage.getItem(botThreadKey("scout", "bob"))).toBe(
    "bob-owned-thread",
  );
});
test("identity/capability loading does not issue a mint and a ready thread survives remount", async () => {
  const view = render(<Chat enabled={false} />);
  await settleReactWork();
  expect(calls).toHaveLength(0);
  view.rerender(<Chat />);
  await waitFor(() =>
    expect(view.getByTestId("thread").textContent).toBe("minted-by-server"),
  );
  view.unmount();
  reply = async () => Response.json({ known: true });
  const reloaded = render(<Chat />);
  await waitFor(() =>
    expect(reloaded.getByTestId("thread").textContent).toBe("minted-by-server"),
  );
  expect(calls).toEqual(["/api/threads/mint", "/api/threads/minted-by-server"]);
});
