import type { ScoutTaskView } from "@openbot/shared/scout";
import { queryOptions } from "@tanstack/react-query";
import { client } from "./client";

export const scoutKeys = (userId: string, channelId: string) =>
  ["scout-drafts", userId, channelId] as const;

export function scoutDrafts(userId: string, channelId: string) {
  return queryOptions({
    queryKey: scoutKeys(userId, channelId),
    enabled: Boolean(userId),
    retry: false,
    queryFn: async () => {
      const tasks = await client<ScoutTaskView[]>(
        `/api/scout/tasks?channelId=${encodeURIComponent(channelId)}`,
        "tasks",
        {
          fallback: "Couldn't load delegated drafts.",
        },
      );
      return tasks.filter((task) => task.channelId === channelId);
    },
  });
}

/** Persist just the opaque retry nonce, never the prompt or an authority claim. */
export function scoutSourceId(
  userId: string,
  channelId: string,
  renew = false,
) {
  const key = `scout-draft-source:${userId}:${channelId}`;
  let id: string | null = null;
  try {
    id = window.sessionStorage.getItem(key);
  } catch {
    /* Browser storage may be disabled. */
  }
  if (renew || !id || !/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(id))
    id = crypto.randomUUID();
  try {
    window.sessionStorage.setItem(key, id);
  } catch {
    /* The server still retains committed intents. */
  }
  return id;
}

export const submitScoutDraft = (input: {
  sourceId: string;
  channelId: string;
  title: string;
  instructions: string;
}) =>
  client<ScoutTaskView>("/api/scout/tasks", "task", {
    method: "POST",
    body: input,
  });

export function changeScoutDraft(
  task: ScoutTaskView,
  action: "refresh" | "recover" | "accept" | "cancel",
) {
  return client<ScoutTaskView>(
    `/api/scout/tasks/${encodeURIComponent(task.id)}`,
    "task",
    {
      method: "POST",
      body: {
        action,
        ...(action === "accept" || action === "cancel"
          ? { revision: task.revision }
          : {}),
        ...(action === "accept" ? { draftDigest: task.draftDigest } : {}),
      },
    },
  );
}
