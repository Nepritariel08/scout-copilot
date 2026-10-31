import type { ScoutTaskView } from "@openbot/shared/scout";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  changeScoutDraft,
  scoutDrafts,
  scoutKeys,
  scoutSourceId,
  submitScoutDraft,
} from "@/lib/scout";

const states: Record<ScoutTaskView["state"], string> = {
  submission_unknown: "Submission needs recovery",
  queued: "Queued",
  running: "Working",
  review_required: "Ready for review",
  completed: "Accepted",
  cancelled: "Cancelled",
  failed: "Failed",
};

/** Explicit delegation, separate from sending a second ordinary chat turn. */
export function ScoutDrafts({ channelId }: { channelId: string }) {
  const user = useQuery(currentUserQueryOptions());
  if (!user.data) return null;
  return (
    <Drafts
      key={`${user.data.id}:${channelId}`}
      userId={user.data.id}
      channelId={channelId}
    />
  );
}

function Drafts({ userId, channelId }: { userId: string; channelId: string }) {
  const cache = useQueryClient();
  const drafts = useQuery(scoutDrafts(userId, channelId));
  const formId = useId();
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [sourceId, setSourceId] = useState(() =>
    scoutSourceId(userId, channelId),
  );
  const refresh = () =>
    cache.invalidateQueries({ queryKey: scoutKeys(userId, channelId) });
  const submit = useMutation({
    mutationFn: () =>
      submitScoutDraft({ sourceId, channelId, title, instructions }),
    onSuccess: async () => {
      setTitle("");
      setInstructions("");
      setSourceId(scoutSourceId(userId, channelId, true));
      await refresh();
    },
    onError: refresh,
  });
  return (
    <details className="mx-3 my-2 rounded-lg border bg-card p-3 text-card-foreground">
      <summary className="cursor-pointer font-medium">Delegated drafts</summary>
      <div className="mt-3 max-h-80 space-y-4 overflow-y-auto">
        <p className="text-sm text-muted-foreground">
          DSH returns a draft here for your review. Closing Scout leaves its
          work running.
        </p>
        {drafts.isPending ? <p role="status">Loading drafts…</p> : null}
        {drafts.isError ? <p role="alert">{drafts.error.message}</p> : null}
        {!drafts.isError && !drafts.isPending ? (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              submit.mutate();
            }}
          >
            <label className="block text-sm" htmlFor={`${formId}-title`}>
              Draft title
            </label>
            <Input
              id={`${formId}-title`}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              maxLength={200}
              disabled={submit.isPending}
            />
            <label className="block text-sm" htmlFor={`${formId}-instructions`}>
              Instructions and permitted context
            </label>
            <Textarea
              id={`${formId}-instructions`}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              required
              maxLength={8000}
              disabled={submit.isPending}
            />
            <Button type="submit" disabled={submit.isPending}>
              {submit.isPending ? "Submitting…" : "Delegate draft"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={submit.isPending}
              onClick={() => {
                setTitle("");
                setInstructions("");
                setSourceId(scoutSourceId(userId, channelId, true));
                submit.reset();
              }}
            >
              Start another draft
            </Button>
          </form>
        ) : null}
        {submit.isError ? <p role="alert">{submit.error.message}</p> : null}
        {drafts.data?.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No delegated drafts in this conversation.
          </p>
        ) : null}
        {drafts.data?.map((task) => (
          <Draft key={task.id} task={task} refresh={refresh} />
        ))}
        <Button
          type="button"
          variant="outline"
          onClick={() => void drafts.refetch()}
        >
          Refresh drafts
        </Button>
      </div>
    </details>
  );
}

function Draft({
  task,
  refresh,
}: {
  task: ScoutTaskView;
  refresh: () => Promise<unknown>;
}) {
  const change = useMutation({
    mutationFn: (action: "refresh" | "recover" | "accept" | "cancel") =>
      changeScoutDraft(task, action),
    onSuccess: refresh,
    onError: refresh,
  });
  const mutable = ["queued", "running", "review_required", "failed"].includes(
    task.state,
  );
  return (
    <article className="space-y-2 rounded-lg border p-3">
      <h3 className="font-medium">{task.title}</h3>
      <p className="text-sm" role="status">
        {states[task.state]}
      </p>
      {/* Render the returned draft as text. Model output cannot install markup or an action. */}
      {task.result ? (
        <pre className="whitespace-pre-wrap break-words font-sans text-sm">
          {task.result}
        </pre>
      ) : null}
      {task.state === "failed" ? (
        <p className="text-sm">
          The remote task failed. Refresh to check its receipt.
        </p>
      ) : null}
      {change.isError ? <p role="alert">{change.error.message}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={change.isPending}
          onClick={() =>
            change.mutate(
              task.state === "submission_unknown" ? "recover" : "refresh",
            )
          }
        >
          {task.state === "submission_unknown"
            ? "Recover submission"
            : "Refresh status"}
        </Button>
        {task.state === "review_required" && task.result ? (
          <Button
            type="button"
            disabled={change.isPending}
            onClick={() => change.mutate("accept")}
          >
            Accept draft
          </Button>
        ) : null}
        {mutable ? (
          <Button
            type="button"
            variant="outline"
            disabled={change.isPending}
            onClick={() => change.mutate("cancel")}
          >
            Cancel task
          </Button>
        ) : null}
      </div>
    </article>
  );
}
