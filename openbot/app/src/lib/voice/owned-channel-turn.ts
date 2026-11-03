import type { Message } from "@ag-ui/core";
import type { OwnedSpeechMessage } from "@openbot/shared/owned-voice";
import type { StoredThread } from "@/lib/copilot/thread-messages";

/** One ordinary chat turn, followed by one authorized saved-message read. */
export function createOwnedChannelVoiceTurn<T>(options: {
  isCurrent(): boolean;
  send(
    text: string,
    hooks: { skipIf(): boolean; onTarget(target: T): void },
  ): Promise<unknown>;
  assistantIds(target: T): ReadonlySet<string>;
  replyId(target: T): string | undefined;
  read(signal: AbortSignal): Promise<StoredThread>;
  cancel(target: T): void | Promise<void>;
  threadId: string;
}) {
  type Turn = {
    cancelled: boolean;
    captured: boolean;
    target: T | null;
    before: ReadonlySet<string>;
  };
  let active: Turn | null = null;
  const cancel = async () => {
    const turn = active;
    if (!turn || turn.cancelled) return;
    turn.cancelled = true;
    // This is the exact agent that started this voice turn, even after navigation.
    const target = turn.target;
    turn.target = null;
    if (target !== null) await options.cancel(target);
  };
  const ask = async (
    text: string,
    signal: AbortSignal,
  ): Promise<OwnedSpeechMessage> => {
    if (active || signal.aborted || !options.isCurrent())
      throw new Error("This voice conversation is no longer available.");
    const turn: Turn = {
      cancelled: false,
      captured: false,
      target: null,
      before: new Set(),
    };
    active = turn;
    const stopped = () =>
      turn.cancelled || signal.aborted || !options.isCurrent();
    const abort = () => {
      void cancel().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await options.send(text, {
        skipIf: stopped,
        onTarget: (target) => {
          if (stopped())
            throw new Error("The voice turn stopped before it was sent.");
          turn.target = target;
          turn.captured = true;
          turn.before = options.assistantIds(target);
        },
      });
      const replyId =
        turn.target === null ? undefined : options.replyId(turn.target);
      // A read failure must never retry the model or stop another later turn.
      turn.target = null;
      if (stopped()) throw new Error("The voice turn was stopped.");
      if (!turn.captured)
        throw new Error("The voice turn did not start. Review the chat.");
      const saved = await options.read(signal);
      if (stopped()) throw new Error("The voice turn was stopped.");
      const latest = saved.messages.findLast(
        (message: Message) => message.role === "assistant",
      );
      if (
        saved.availability !== "ready" ||
        saved.unreadable !== 0 ||
        !replyId ||
        !latest ||
        latest.id !== replyId ||
        turn.before.has(latest.id) ||
        typeof latest.content !== "string" ||
        !latest.content.trim() ||
        latest.toolCalls?.length
      )
        throw new Error(
          "The reply could not be verified in saved history. Review the chat before starting voice again.",
        );
      // Only IDs leave this boundary. The speech server checks run completion,
      // membership and current source grants again and reads the text itself.
      return { threadId: options.threadId, messageId: latest.id };
    } finally {
      signal.removeEventListener("abort", abort);
      if (active === turn) active = null;
    }
  };
  return { ask, cancel, isAsking: () => active !== null };
}
