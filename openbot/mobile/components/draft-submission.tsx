import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { useEffect, useRef, useState } from "react";
import { Button, Text, View } from "react-native";
import type { ChatMessage } from "../src/api";
import {
  type DraftSubmission,
  draftForSavedMessage,
  inspectDraftSubmission,
  type SubmissionContext,
  submitReviewedDraft,
} from "../src/draft-submission";
import {
  type AuthenticatedApi,
  sameWorkScope,
  type WorkScope,
} from "../src/scout-work";

export function DraftSubmissionPanel({
  scope,
  serverUrl,
  client,
  persistedMessages,
  isCurrent,
  disabled,
  onChange,
}: {
  scope: WorkScope;
  serverUrl: string;
  client: AuthenticatedApi;
  persistedMessages: readonly ChatMessage[];
  isCurrent(): boolean;
  disabled: boolean;
  onChange(): void;
}) {
  const [reviewed, setReviewed] = useState<DraftSubmission>();
  const [status, setStatus] =
    useState<Awaited<ReturnType<typeof inspectDraftSubmission>>>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const alive = useRef(true);
  const inFlight = useRef(false);
  const messages = useRef(persistedMessages);
  messages.current = persistedMessages;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const context: SubmissionContext = {
    scope,
    serverUrl,
    isCurrent: () =>
      alive.current &&
      isCurrent() &&
      sameWorkScope(currentScope.current, scope),
    persistedMessages: () => messages.current,
    client,
    storage: SecureStore,
    digest: (value) =>
      Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
  };
  const candidates = persistedMessages
    .flatMap((message) => {
      const draft = draftForSavedMessage(message, scope.channelId);
      return draft ? [draft] : [];
    })
    .reverse();

  async function run(
    selection: DraftSubmission,
    action: "check" | "submit" | "recover",
  ) {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    setNotice("");
    setReviewed(selection);
    setStatus(undefined);
    try {
      if (action !== "check") {
        const result = await submitReviewedDraft(context, selection, action);
        if (!context.isCurrent()) return;
        setNotice(
          result.kind === "existing"
            ? "This message already has a request. Review its receipt below."
            : result.task.state === "submission_unknown"
              ? "The request is saved; submission still needs recovery."
              : "Draft request confirmed. Its result will appear below for review.",
        );
        onChange();
      }
    } catch (caught) {
      if (!context.isCurrent()) return;
      setError(
        caught instanceof Error
          ? caught.message
          : "The request was not confirmed. Check its status before recovering.",
      );
    }
    if (!context.isCurrent()) return;
    try {
      const next = await inspectDraftSubmission(context, selection);
      if (context.isCurrent()) setStatus(next);
    } catch (caught) {
      if (context.isCurrent())
        setError(
          (current) =>
            current ||
            (caught instanceof Error
              ? caught.message
              : "Could not check the saved request."),
        );
    } finally {
      inFlight.current = false;
      if (context.isCurrent()) setPending(false);
    }
  }

  const canRecover =
    status?.available &&
    (status.attempted || status.task) &&
    (!status.task || status.task.state === "submission_unknown");
  const canSubmit = status?.available && !status.attempted && !status.task;
  return (
    <View style={{ gap: 10, paddingBottom: 12 }}>
      <Text style={{ fontWeight: "600" }}>Delegate a saved message</Text>
      <Text>
        Choose a saved message, review its exact text, then ask DSH to draft a
        result. Include only context you may share. This sends a separate draft
        request.
      </Text>
      {candidates.length ? (
        candidates.map((candidate) => (
          <Button
            key={candidate.sourceId}
            title={`Review message: ${candidate.title.slice(0, 60)}`}
            disabled={pending || disabled}
            onPress={() => void run(candidate, "check")}
          />
        ))
      ) : (
        <Text>
          A saved text message of up to 8,000 characters is needed. Refresh the
          conversation after sending one.
        </Text>
      )}
      {reviewed ? (
        <>
          <Text style={{ fontWeight: "600" }}>{reviewed.title}</Text>
          <Text selectable>{reviewed.instructions}</Text>
          <Text>
            The title is taken from this message’s first line. Its saved message
            ID stays the same for retries.
          </Text>
          {pending ? (
            <Text accessibilityLiveRegion="polite">
              Checking the saved request…
            </Text>
          ) : null}
          {status && !status.available ? (
            <Text>Draft delegation is not available in this workspace.</Text>
          ) : null}
          {canSubmit ? (
            <Button
              title="Delegate reviewed message to DSH"
              disabled={pending || disabled}
              onPress={() => void run(reviewed, "submit")}
            />
          ) : null}
          {canRecover ? (
            <>
              <Text>
                The outcome is not confirmed. Recovery uses the same saved
                message and exact request; it does not create a new intent.
              </Text>
              <Button
                title="Recover the same reviewed request"
                disabled={pending || disabled}
                onPress={() => void run(reviewed, "recover")}
              />
            </>
          ) : null}
          {status?.task && status.task.state !== "submission_unknown" ? (
            <Text>
              This message already has a request. See its receipt in the draft
              list.
            </Text>
          ) : null}
          <Button
            title="Check request status"
            disabled={pending || disabled}
            onPress={() => void run(reviewed, "check")}
          />
        </>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: "#b42318" }}>
          {error}
        </Text>
      ) : null}
      {notice ? <Text accessibilityLiveRegion="polite">{notice}</Text> : null}
    </View>
  );
}
