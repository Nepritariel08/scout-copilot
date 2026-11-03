import {
  dictationExtension,
  dictationMediaType,
} from "@openbot/shared/dictation";
import { OWNED_SPEECH } from "@openbot/shared/owned-voice";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppVariables } from "../../auth/guards";
import { HistoryError, historyDigest } from "../history/protocol";
import type { BoundHistory } from "../history/service";
import type { OwnedSpeechBackend } from "./backend";

const identity = z.string().min(1).max(200);
const playbackInput = z.strictObject({
  threadId: identity,
  messageId: identity,
});

type SpeechHistory = Pick<BoundHistory, "snapshot" | "page" | "status">;
type SpeechAuthority = {
  requireTenant: MiddlewareHandler<{ Variables: AppVariables }>;
  binding(request: Request): Promise<{
    person: { id: string };
    policy: {
      userId: string;
      tenantId: string;
      deploymentId: string;
      fingerprint: string;
      expiresAt: string;
    };
  }>;
};

/** Completed server events, not a client claim, determine which saved message can be spoken. */
export async function ownedSpeechText(
  history: SpeechHistory,
  input: z.infer<typeof playbackInput>,
): Promise<string> {
  // The existing status port includes both running and stop_requested history runs.
  if ((await history.status(input.threadId)).running)
    throw new HistoryError("HISTORY_CONFLICT");
  const snapshot = await history.snapshot(input.threadId);
  const message = snapshot.messages.findLast(
    (value) => value.role === "assistant",
  );
  if (
    !message ||
    message.id !== input.messageId ||
    message.role !== "assistant" ||
    typeof message.content !== "string" ||
    !message.content.trim() ||
    message.content.length > OWNED_SPEECH.maxTextCharacters ||
    message.toolCalls?.length
  )
    throw new HistoryError("HISTORY_ACCESS_DENIED");
  let cursor = 0;
  let currentRun: string | undefined;
  let messageRun: string | undefined;
  let started = false;
  let ended = false;
  let finished = false;
  // Fail closed beyond 2,048 events; speech must not scan an arbitrarily large conversation.
  for (let pages = 0; pages < 16; pages++) {
    const page = await history.page(input.threadId, cursor);
    if (page.running) throw new HistoryError("HISTORY_CONFLICT");
    for (const row of page.events) {
      cursor = row.sequence;
      const event = row.event;
      if (event.type === "RUN_STARTED" && typeof event.runId === "string")
        currentRun = event.runId;
      if (event.type === "RUN_ERROR" && messageRun && currentRun === messageRun)
        throw new HistoryError("HISTORY_CONFLICT");
      if (
        event.type === "TEXT_MESSAGE_START" &&
        event.messageId === input.messageId
      ) {
        started = event.role === "assistant";
        messageRun = currentRun;
      }
      if (
        event.type === "TEXT_MESSAGE_END" &&
        event.messageId === input.messageId
      )
        ended = started;
      if (
        event.type === "RUN_FINISHED" &&
        messageRun &&
        event.runId === messageRun
      ) {
        const outcome = event.outcome;
        if (
          event.threadId !== input.threadId ||
          (outcome !== undefined &&
            (!outcome ||
              typeof outcome !== "object" ||
              !("type" in outcome) ||
              outcome.type !== "success"))
        )
          throw new HistoryError("HISTORY_CONFLICT");
        finished = true;
      }
    }
    if (page.events.length < 128) {
      if (!messageRun || !started || !ended || !finished)
        throw new HistoryError("HISTORY_CONFLICT");
      if ((await history.status(input.threadId)).running)
        throw new HistoryError("HISTORY_CONFLICT");
      return message.content;
    }
  }
  throw new HistoryError("HISTORY_LIMIT");
}

/** Mount once, before the owned auxiliary-route refusal. Backend remains absent by default. */
export function createOwnedSpeechRoutes(deps: {
  authority: SpeechAuthority;
  history(request: Request): SpeechHistory;
  backend?: OwnedSpeechBackend;
}) {
  const app = new Hono<{ Variables: AppVariables }>();
  let active = false;
  app.use("*", deps.authority.requireTenant);
  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    const origin = context.req.header("origin");
    if (
      context.req.header("x-openbot-dictation") !== "1" ||
      (origin && origin !== new URL(context.req.url).origin)
    )
      return context.json({ code: "SPEECH_ACCESS_DENIED" }, 403);
    if (!deps.backend) return context.json({ code: "SPEECH_UNAVAILABLE" }, 503);
    if (active) return context.json({ code: "SPEECH_BUSY" }, 429);
    active = true;
    // Do not race the backend against the client abort: native work keeps its slot until done.
    try {
      await next();
    } finally {
      active = false;
    }
  });
  app.onError((error, context) =>
    context.json(
      {
        code:
          error instanceof HistoryError
            ? "SPEECH_ACCESS_DENIED"
            : "SPEECH_UNAVAILABLE",
      },
      error instanceof HistoryError ? 403 : 503,
    ),
  );
  const admission = async (request: Request) => {
    const before = await deps.authority.binding(request);
    const fingerprint = historyDigest(before);
    return async () => {
      if (historyDigest(await deps.authority.binding(request)) !== fingerprint)
        throw new HistoryError("HISTORY_ACCESS_DENIED");
    };
  };
  app.post(
    "/api/audio/transcriptions",
    bodyLimit({ maxSize: OWNED_SPEECH.maxUploadBytes + 65_536 }),
    async (context) => {
      const check = await admission(context.req.raw);
      const body = await context.req.raw.formData().catch(() => null);
      const file = body?.get("file");
      if (
        !body ||
        [...body.keys()].join(",") !== "file" ||
        !(file instanceof File) ||
        !file.size ||
        file.size > OWNED_SPEECH.maxUploadBytes
      )
        return context.json({ code: "SPEECH_INPUT_INVALID" }, 400);
      const type = dictationMediaType(file.type);
      const extension = dictationExtension(type);
      if (!extension)
        return context.json({ code: "SPEECH_INPUT_INVALID" }, 415);
      await check();
      const backend = deps.backend;
      if (!backend) return context.json({ code: "SPEECH_UNAVAILABLE" }, 503);
      if (context.req.raw.signal.aborted)
        return new Response(null, { status: 499 });
      const text = await backend.transcribe(
        new File([file], `recording.${extension}`, { type }),
      );
      await check();
      if (context.req.raw.signal.aborted)
        return new Response(null, { status: 499 });
      if (!text.trim()) return context.json({ code: "SPEECH_EMPTY" }, 422);
      if (
        new TextEncoder().encode(text).byteLength >
        OWNED_SPEECH.maxTranscriptBytes
      )
        return context.json({ code: "SPEECH_UNAVAILABLE" }, 503);
      return context.json({ text });
    },
  );
  app.post(
    "/api/audio/speech",
    bodyLimit({ maxSize: 2048 }),
    async (context) => {
      const input = playbackInput.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!input.success)
        return context.json({ code: "SPEECH_INPUT_INVALID" }, 400);
      const check = await admission(context.req.raw);
      const history = deps.history(context.req.raw);
      const text = await ownedSpeechText(history, input.data);
      await check();
      const backend = deps.backend;
      if (!backend) return context.json({ code: "SPEECH_UNAVAILABLE" }, 503);
      if (context.req.raw.signal.aborted)
        return new Response(null, { status: 499 });
      const audio = await backend.synthesize(text);
      // Re-read the same saved message, complete run and current context/ACL after native I/O.
      if ((await ownedSpeechText(history, input.data)) !== text)
        throw new HistoryError("HISTORY_ACCESS_DENIED");
      await check();
      if (context.req.raw.signal.aborted)
        return new Response(null, { status: 499 });
      return new Response(new Uint8Array(audio), {
        headers: { "content-type": "audio/wav", "cache-control": "no-store" },
      });
    },
  );
  return app;
}
