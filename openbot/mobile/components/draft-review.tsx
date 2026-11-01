import { useEffect, useRef, useState } from "react";
import { Button, Text, View } from "react-native";
import {
  type AuthenticatedApi,
  acceptReviewedDraft,
  canAcceptDraft,
  type DraftReceipt,
  readDrafts,
  refreshDraft,
  sameReviewedDraft,
} from "../src/scout-work";

const stateNames: Record<DraftReceipt["state"], string> = {
  submission_unknown: "Submission needs recovery in Scout web",
  queued: "Queued",
  running: "Working",
  review_required: "Ready for review",
  completed: "Accepted",
  cancelled: "Cancelled",
  failed: "Failed",
};

/** Existing queue receipts only: no submission, timer, recovery worker or automatic acceptance. */
export function DraftReviewPanel({
  channelId,
  client,
}: {
  channelId: string;
  client: AuthenticatedApi;
}) {
  const [expanded, setExpanded] = useState(false);
  const [available, setAvailable] = useState<boolean>();
  const [tasks, setTasks] = useState<DraftReceipt[]>([]);
  const [reviewed, setReviewed] = useState<DraftReceipt>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const alive = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function load() {
    const next = await readDrafts(client, channelId);
    if (!alive.current) return;
    setAvailable(next.available);
    setTasks(next.tasks);
    setReviewed(undefined);
  }

  async function run(task?: DraftReceipt, acceptance?: DraftReceipt) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    setNotice("");
    setReviewed(undefined);
    let operationError = "";
    try {
      if (task) {
        if (acceptance)
          await acceptReviewedDraft(client, channelId, task, acceptance);
        else await refreshDraft(client, channelId, task);
        if (alive.current)
          setNotice(
            acceptance
              ? "Draft acceptance confirmed."
              : "Draft receipt refreshed.",
          );
      }
    } catch (caught) {
      operationError =
        caught instanceof Error
          ? caught.message
          : "The draft operation was not confirmed.";
      if (alive.current) setError(operationError);
    }
    if (!alive.current) return;
    try {
      await load();
    } catch (caught) {
      if (alive.current) {
        setAvailable(undefined);
        setTasks([]);
        if (!operationError)
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not load delegated drafts.",
          );
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setPending(false);
    }
  }

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: "#d0d5dd",
        borderRadius: 8,
        padding: 12,
        gap: 10,
      }}
    >
      <Button
        title={expanded ? "Hide DSH draft review" : "DSH draft review"}
        onPress={() => {
          setExpanded(!expanded);
          if (!expanded) void run();
        }}
      />
      {expanded ? (
        <>
          <Text>
            Review existing DSH drafts for this conversation. Acceptance applies
            to the exact result and revision you reviewed.
          </Text>
          {pending ? (
            <Text accessibilityLiveRegion="polite">
              Checking draft receipts…
            </Text>
          ) : null}
          {available === false ? (
            <Text>Draft review is not available in this workspace yet.</Text>
          ) : null}
          {available && tasks.length === 0 && !pending ? (
            <Text>No delegated drafts in this conversation.</Text>
          ) : null}
          {tasks.map((task) => {
            const confirming = reviewed && sameReviewedDraft(task, reviewed);
            return (
              <View
                key={task.id}
                style={{
                  borderTopWidth: 1,
                  borderColor: "#d0d5dd",
                  paddingTop: 10,
                  gap: 8,
                }}
              >
                <Text style={{ fontWeight: "600" }}>{task.title}</Text>
                <Text>
                  {stateNames[task.state]}
                  {task.workItemId ? `; work item #${task.workItemId}` : ""}
                  {task.revision ? `; revision ${task.revision}` : ""}
                </Text>
                {task.result ? <Text selectable>{task.result}</Text> : null}
                <Button
                  title="Refresh draft status"
                  disabled={pending}
                  onPress={() => void run(task)}
                />
                {canAcceptDraft(task) && !confirming ? (
                  <Button
                    title="Review draft for acceptance"
                    disabled={pending}
                    onPress={() => {
                      setReviewed({ ...task });
                      setError("");
                      setNotice("");
                    }}
                  />
                ) : null}
                {confirming ? (
                  <>
                    <Text>
                      Confirm that you reviewed the text above, revision{" "}
                      {reviewed.revision}. Accepting records your review of this
                      draft.
                    </Text>
                    <Button
                      title="Accept reviewed draft"
                      disabled={pending}
                      onPress={() => void run(task, reviewed)}
                    />
                    <Button
                      title="Keep reviewing"
                      disabled={pending}
                      onPress={() => setReviewed(undefined)}
                    />
                  </>
                ) : null}
              </View>
            );
          })}
          <Button
            title="Refresh draft list"
            disabled={pending}
            onPress={() => void run()}
          />
          {error ? (
            <Text accessibilityRole="alert" style={{ color: "#b42318" }}>
              {error}
            </Text>
          ) : null}
          {notice ? (
            <Text accessibilityLiveRegion="polite">{notice}</Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
