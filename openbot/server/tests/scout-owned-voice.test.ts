import { describe, expect, test } from "bun:test";
import { type BaseEvent, EventType } from "@ag-ui/client";
import { OWNED_SPEECH } from "@openbot/shared/owned-voice";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { HistoryError } from "../src/scout/history/protocol";
import { createOwnedSpeechBackend } from "../src/scout/owned-voice/backend";
import { createOwnedSpeechRoutes } from "../src/scout/owned-voice/routes";

const saved = {
  threadId: "thread-synthetic",
  messageId: "assistant-synthetic",
};
function fixture() {
  let revoked = false;
  let fingerprint = "synthetic-binding";
  let role: "assistant" | "user" = "assistant";
  let content = "Synthetic saved answer.";
  let latest = true;
  let running = false;
  let terminal: BaseEvent = {
    type: EventType.RUN_FINISHED,
    threadId: saved.threadId,
    runId: "run-synthetic",
  };
  let synthesize = async (_text: string) => new Uint8Array([1, 2, 3]);
  let transcribe = async (_file: File) => "Synthetic transcript.";
  const seen: string[] = [];
  const authority = {
    requireTenant: (async (_context, next) => {
      await next();
    }) as import("hono").MiddlewareHandler<{ Variables: AppVariables }>,
    async binding(_request: Request) {
      if (revoked) throw new HistoryError("HISTORY_ACCESS_DENIED");
      return {
        person: { id: "native-synthetic" },
        policy: {
          userId: "native-synthetic",
          tenantId: "tenant-synthetic",
          deploymentId: "pilot-synthetic",
          fingerprint,
          expiresAt: "2099-01-01T00:00:00Z",
        },
      };
    },
  };
  const history = {
    async snapshot(threadId: string) {
      if (revoked || threadId !== saved.threadId)
        throw new HistoryError("HISTORY_ACCESS_DENIED");
      return {
        messages: [
          { id: saved.messageId, role, content },
          ...(latest
            ? []
            : [
                {
                  id: "newer",
                  role: "assistant" as const,
                  content: "Newer answer",
                },
              ]),
        ],
        state: {},
      };
    },
    async status() {
      return { running };
    },
    async page(threadId: string) {
      if (revoked || threadId !== saved.threadId)
        throw new HistoryError("HISTORY_ACCESS_DENIED");
      const events: BaseEvent[] = [
        {
          type: EventType.RUN_STARTED,
          threadId: saved.threadId,
          runId: "run-synthetic",
        },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: saved.messageId,
          role: "assistant",
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: saved.messageId },
        terminal,
      ];
      return {
        events: events.map((event, index) => ({ sequence: index + 1, event })),
        running,
        tail: 4,
      };
    },
  };
  const app = new Hono().route(
    "/",
    createOwnedSpeechRoutes({
      authority,
      history: () => history,
      backend: {
        synthesize: async (text) => {
          seen.push(text);
          return synthesize(text);
        },
        transcribe: async (file) => {
          seen.push(file.type);
          return transcribe(file);
        },
      },
    }),
  );
  const request = (body: unknown = saved, extra: Record<string, string> = {}) =>
    app.request("http://localhost/api/audio/speech", {
      method: "POST",
      headers: {
        "x-openbot-dictation": "1",
        "content-type": "application/json",
        ...extra,
      },
      body: JSON.stringify(body),
    });
  return {
    app,
    request,
    seen,
    authority,
    history,
    revoke: () => {
      revoked = true;
    },
    changeBinding: () => {
      fingerprint = "changed";
    },
    setRole: (value: typeof role) => {
      role = value;
    },
    setContent: (value: string) => {
      content = value;
    },
    setLatest: (value: boolean) => {
      latest = value;
    },
    setRunning: (value: boolean) => {
      running = value;
    },
    setTerminal: (value: BaseEvent) => {
      terminal = value;
    },
    setSynthesis: (value: typeof synthesize) => {
      synthesize = value;
    },
    setTranscription: (value: typeof transcribe) => {
      transcribe = value;
    },
  };
}

describe("owned speech admission and saved-message playback", () => {
  test("only exact latest completed saved assistant text is sent; no-store", async () => {
    const f = fixture();
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(f.seen).toEqual(["Synthetic saved answer."]);
  });
  test("rejects client text/model/URL/identity overrides and cross-origin", async () => {
    for (const extra of [
      { text: "spoof" },
      { provider: "cloud" },
      { url: "http://external.invalid" },
      { userId: "other" },
      { runId: "spoof" },
    ]) {
      const f = fixture();
      expect((await f.request({ ...saved, ...extra })).status).toBe(400);
      expect(f.seen).toEqual([]);
    }
    expect(
      (await fixture().request(saved, { origin: "https://external.invalid" }))
        .status,
    ).toBe(403);
  });

  test("accepts the public AG-UI explicit success completion outcome", async () => {
    const f = fixture();
    f.setTerminal({
      type: EventType.RUN_FINISHED,
      threadId: saved.threadId,
      runId: "run-synthetic",
      outcome: { type: "success" },
    });
    expect((await f.request()).status).toBe(200);
  });
  test("refuses user/old/oversized/cross-thread/running/error/cancelled messages", async () => {
    const variants = [
      (f: ReturnType<typeof fixture>) => f.setRole("user"),
      (f: ReturnType<typeof fixture>) => f.setLatest(false),
      (f: ReturnType<typeof fixture>) => f.setContent("x".repeat(2001)),
      (f: ReturnType<typeof fixture>) => f.setRunning(true),
      (f: ReturnType<typeof fixture>) =>
        f.setTerminal({ type: EventType.RUN_ERROR, message: "synthetic" }),
      (f: ReturnType<typeof fixture>) =>
        f.setTerminal({
          type: EventType.RUN_FINISHED,
          threadId: saved.threadId,
          runId: "run-synthetic",
          outcome: { type: "cancelled" },
        }),
    ];
    for (const change of variants) {
      const f = fixture();
      change(f);
      expect((await f.request()).status).toBe(403);
      expect(f.seen).toEqual([]);
    }
    expect(
      (await fixture().request({ ...saved, threadId: "other-owner" })).status,
    ).toBe(403);
  });
  test("withholds audio after native membership/context revocation or saved text changes", async () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => f.revoke(),
      (f: ReturnType<typeof fixture>) => f.changeBinding(),
      (f: ReturnType<typeof fixture>) => f.setContent("Changed"),
    ]) {
      const f = fixture();
      f.setSynthesis(async () => {
        change(f);
        return new Uint8Array([1]);
      });
      expect((await f.request()).status).toBe(403);
    }
  });
  test("native work keeps the one global slot until it settles", async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.setSynthesis(async () => {
      await blocked;
      return new Uint8Array([1]);
    });
    const first = f.request();
    while (!f.seen.length)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect((await f.request()).status).toBe(429);
    release?.();
    expect((await first).status).toBe(200);
    expect((await f.request()).status).toBe(200);
  });
  test("default missing backend fails closed", async () => {
    const f = fixture();
    const app = createOwnedSpeechRoutes({
      authority: f.authority,
      history: () => f.history,
    });
    expect(
      (
        await app.request("/api/audio/speech", {
          method: "POST",
          headers: { "x-openbot-dictation": "1" },
          body: "{}",
        })
      ).status,
    ).toBe(503);
  });

  test("client cancellation cannot free a running native job or return its audio", async () => {
    const f = fixture();
    const waiting = Promise.withResolvers<void>();
    f.setSynthesis(async () => {
      await waiting.promise;
      return new Uint8Array([1]);
    });
    const controller = new AbortController();
    const first = f.app.fetch(
      new Request("http://localhost/api/audio/speech", {
        method: "POST",
        headers: {
          "x-openbot-dictation": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify(saved),
        signal: controller.signal,
      }),
    );
    while (!f.seen.length)
      await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    expect((await f.request()).status).toBe(429);
    waiting.resolve();
    expect((await first).status).toBe(499);
    expect((await f.request()).status).toBe(200);
  });
  test("owned STT requires exact file field and current native authority", async () => {
    const f = fixture();
    const form = new FormData();
    form.set(
      "file",
      new File(["synthetic"], "recording.webm", { type: "audio/webm" }),
    );
    const response = await f.app.request("/api/audio/transcriptions", {
      method: "POST",
      headers: { "x-openbot-dictation": "1" },
      body: form,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "Synthetic transcript." });
    f.setTranscription(async () => {
      f.revoke();
      return "Withheld";
    });
    expect(
      (
        await f.app.request("/api/audio/transcriptions", {
          method: "POST",
          headers: { "x-openbot-dictation": "1" },
          body: form,
        })
      ).status,
    ).toBe(403);
  });
});

test("owned backend is loopback/fixed profile and bounds actual chunked response", async () => {
  for (const baseUrl of [
    "https://external.invalid/v1",
    "http://localhost:18083/v1",
    "http://127.0.0.1:18083/v1?proxy=1",
  ]) {
    expect(() =>
      createOwnedSpeechBackend({ baseUrl, token: "x".repeat(32) }),
    ).toThrow("CONFIG_INVALID");
  }
  const backend = createOwnedSpeechBackend(
    { baseUrl: "http://127.0.0.1:18083/v1", token: "x".repeat(32) },
    async (url, init) => {
      expect(String(url)).toBe("http://127.0.0.1:18083/v1/audio/speech");
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toEqual({
        input: "Synthetic",
        model: OWNED_SPEECH.ttsModel,
        voice: OWNED_SPEECH.voice,
        response_format: "wav",
      });
      return new Response(new Uint8Array(OWNED_SPEECH.maxAudioBytes + 1), {
        headers: { "content-type": "audio/wav" },
      });
    },
  );
  await expect(backend.synthesize("Synthetic")).rejects.toThrow(
    "SPEECH_RESPONSE_INVALID",
  );
});
