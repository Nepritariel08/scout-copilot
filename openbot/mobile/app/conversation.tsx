import { fetch as expoFetch } from "expo/fetch";
import * as Crypto from "expo-crypto";
import { Redirect, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Button,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { DraftReviewPanel } from "../components/draft-review";
import { OdooContextPanel } from "../components/odoo-context";
import {
  api,
  type ChatMessage,
  type Conversation,
  type ScoutAgent,
} from "../src/api";
import { authClient, serverUrl } from "../src/auth";
import {
  buildOwnedRunInput,
  clearForIdentityChange,
  dataForSignedInUser,
  readOwnedHistory,
  recoverFailedSend,
  runOwnedAgent,
} from "../src/owned-chat";
import {
  consumeOdooTaskSelection,
  type OdooTaskSelection,
  refreshForCurrentScope,
  sameWorkScope,
  selectedOdooTask,
} from "../src/scout-work";

type ConversationData = {
  channelId: string;
  conversation: Conversation;
  agent: ScoutAgent;
  messages: ChatMessage[];
};

export default function ConversationScreen() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();
  const { data: session, isPending } = authClient.useSession();
  const [view, setView] = useState<{
    userId: string;
    value: ConversationData;
  }>();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const sendInFlight = useRef(false);
  const [taskSelection, setTaskSelection] = useState<OdooTaskSelection>();
  const pendingTaskSelection = useRef<OdooTaskSelection | undefined>(undefined);
  const [turnSelection, setTurnSelection] = useState<OdooTaskSelection>();
  const mounted = useRef(false);
  const refreshGeneration = useRef(0);
  const activeScope = useRef({ userId: session?.user.id, channelId });
  activeScope.current = { userId: session?.user.id, channelId };
  const previousScope = useRef({ userId: session?.user.id, channelId });

  const userView = dataForSignedInUser(view, session?.user.id);
  const conversationData =
    userView?.channelId === channelId ? userView : undefined;
  const conversation = conversationData?.conversation;
  const agent = conversationData?.agent;
  const messages = conversationData?.messages ?? [];
  const workScope = {
    userId: session?.user.id ?? "",
    channelId: channelId ?? "",
    agentId: agent?.id ?? "",
  };
  const activeWorkScope = useRef(workScope);
  activeWorkScope.current = workScope;
  const selectedTaskId = selectedOdooTask(taskSelection, workScope);
  const turnTaskId = selectedOdooTask(turnSelection, workScope);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      refreshGeneration.current += 1;
    };
  }, []);

  useEffect(() => {
    const scope = {
      userId: session?.user.id ?? "",
      channelId: channelId ?? "",
      agentId: agent?.id ?? "",
    };
    if (!selectedOdooTask(pendingTaskSelection.current, scope))
      pendingTaskSelection.current = undefined;
    setTaskSelection((current) =>
      current && sameWorkScope(current, scope) ? current : undefined,
    );
    setTurnSelection((current) =>
      current && sameWorkScope(current, scope) ? current : undefined,
    );
  }, [session?.user.id, channelId, agent?.id]);

  function selectTask(taskId: string | null) {
    if (!sameWorkScope(activeWorkScope.current, workScope)) return;
    const selection = taskId ? { ...workScope, taskId } : undefined;
    pendingTaskSelection.current = selection;
    setTaskSelection(selection);
  }

  useEffect(() => {
    const identityChanged = previousScope.current.userId !== session?.user.id;
    const channelChanged = previousScope.current.channelId !== channelId;
    previousScope.current = { userId: session?.user.id, channelId };
    if (identityChanged)
      setView((current) => clearForIdentityChange(current, session?.user.id));
    if (identityChanged || channelChanged) {
      setText("");
      setError("");
    }
  }, [channelId, session?.user.id]);

  const refresh = useCallback(
    async (options?: { preserveError?: boolean }) => {
      const userId = session?.user.id;
      if (
        !channelId ||
        !userId ||
        !mounted.current ||
        activeScope.current.userId !== userId ||
        activeScope.current.channelId !== channelId
      )
        return undefined;
      const generation = ++refreshGeneration.current;
      const isCurrent = () =>
        mounted.current &&
        activeScope.current.userId === userId &&
        activeScope.current.channelId === channelId &&
        refreshGeneration.current === generation;
      setLoading(true);
      if (!options?.preserveError) setError("");
      const snapshot = await refreshForCurrentScope<ConversationData>({
        isCurrent,
        read: async () => {
          const [channelResult, agentResult] = await Promise.all([
            api<{ channel: Conversation }>(
              `/api/channels/${encodeURIComponent(channelId)}`,
            ),
            api<{ agents: ScoutAgent[] }>("/api/agents"),
          ]);
          const channel = channelResult.channel;
          const selectedAgent = agentResult.agents.find(
            (candidate) =>
              candidate.builtIn && channel.agentIds.includes(candidate.id),
          );
          if (!selectedAgent)
            throw new Error(
              "This conversation has no available Scout assistant.",
            );

          const cookie = (await authClient.getCookie()) || null;
          const history = await readOwnedHistory({
            serverUrl,
            cookie,
            threadId: channel.threadId,
            agentId: selectedAgent.id,
            fetcher: expoFetch,
          });
          return {
            channelId,
            conversation: channel,
            agent: selectedAgent,
            messages: history,
          };
        },
        apply: (value) => setView({ userId, value }),
        failed: (failure) => {
          if (!options?.preserveError)
            setError(
              failure instanceof Error
                ? failure.message
                : "Could not load this Scout conversation.",
            );
        },
        finished: () => setLoading(false),
      });
      return snapshot?.messages;
    },
    [channelId, session?.user.id],
  );

  useFocusEffect(
    useCallback(() => {
      if (session?.user.id) void refresh();
    }, [refresh, session?.user.id]),
  );

  if (!session && !isPending) return <Redirect href="/" />;

  async function send() {
    const userId = session?.user.id;
    if (
      !conversation ||
      !agent ||
      !userId ||
      !text.trim() ||
      sending ||
      sendInFlight.current
    )
      return;
    const submittedText = text.trim();
    const placeholderId = Crypto.randomUUID();
    const odooTaskId = consumeOdooTaskSelection(
      pendingTaskSelection,
      workScope,
    );
    const run = buildOwnedRunInput({
      threadId: conversation.threadId,
      history: messages,
      text: submittedText,
      selectedOdooTaskId: odooTaskId,
      createId: () => Crypto.randomUUID(),
    });
    sendInFlight.current = true;
    setTurnSelection(
      odooTaskId ? { ...workScope, taskId: odooTaskId } : undefined,
    );
    setTaskSelection(undefined);
    const displayedAssistantId = { value: placeholderId };
    setSending(true);
    setError("");
    setText("");
    setView((current) => {
      if (
        !current ||
        current.userId !== userId ||
        current.value.channelId !== channelId
      )
        return current;
      return {
        ...current,
        value: {
          ...current.value,
          messages: [
            ...current.value.messages,
            run.userMessage,
            { id: placeholderId, role: "assistant", content: "" },
          ],
        },
      };
    });

    let sendError: string | undefined;
    try {
      const cookie = (await authClient.getCookie()) || null;
      await runOwnedAgent({
        serverUrl,
        cookie,
        agentId: agent.id,
        payload: run.payload,
        fetcher: expoFetch,
        onAssistantStart: (messageId) => {
          setView((current) => {
            if (
              !current ||
              current.userId !== userId ||
              current.value.channelId !== channelId
            )
              return current;
            return {
              ...current,
              value: {
                ...current.value,
                messages: current.value.messages.map((message) =>
                  message.id === displayedAssistantId.value
                    ? { ...message, id: messageId }
                    : message,
                ),
              },
            };
          });
          displayedAssistantId.value = messageId;
        },
        onTextDelta: (delta) => {
          setView((current) => {
            if (
              !current ||
              current.userId !== userId ||
              current.value.channelId !== channelId
            )
              return current;
            return {
              ...current,
              value: {
                ...current.value,
                messages: current.value.messages.map((message) =>
                  message.id === displayedAssistantId.value
                    ? {
                        ...message,
                        content:
                          (typeof message.content === "string"
                            ? message.content
                            : "") + delta,
                      }
                    : message,
                ),
              },
            };
          });
        },
      });
    } catch (failure) {
      sendError =
        failure instanceof Error
          ? failure.message
          : "Could not send your message to Scout.";
    } finally {
      if (sendError) {
        await recoverFailedSend({
          error: sendError,
          submittedText,
          previousHistory: messages,
          sentMessage: run.userMessage,
          isCurrentScope: () =>
            activeScope.current.userId === userId &&
            activeScope.current.channelId === channelId,
          refreshHistory: () => refresh({ preserveError: true }),
          setError,
          restoreDraft: (draft) => setText((current) => current || draft),
        });
      } else if (
        activeScope.current.userId === userId &&
        activeScope.current.channelId === channelId
      ) {
        // The server owns the canonical transcript; refresh it after success.
        await refresh();
      }
      setSending(false);
      sendInFlight.current = false;
      if (sameWorkScope(activeWorkScope.current, workScope))
        setTurnSelection(undefined);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1 }}
    >
      <View style={{ flex: 1, padding: 16, gap: 12 }}>
        <Text style={{ fontSize: 22, fontWeight: "600" }}>
          {conversation?.name ?? "Scout conversation"}
        </Text>
        {error ? (
          <Text accessibilityRole="alert" style={{ color: "#b42318" }}>
            {error}
          </Text>
        ) : null}
        {loading && !messages.length ? (
          <ActivityIndicator accessibilityLabel="Loading conversation" />
        ) : null}
        <ScrollView
          style={{ flex: 1 }}
          refreshControl={
            <RefreshControl
              refreshing={loading}
              onRefresh={() => void refresh()}
            />
          }
          contentContainerStyle={{ gap: 12 }}
        >
          {conversation && agent && session?.user.id ? (
            <>
              <OdooContextPanel
                key={`${session.user.id}:${channelId}:${agent.id}:odoo`}
                agentId={agent.id}
                channelId={channelId}
                selectedTaskId={selectedTaskId}
                onSelectTaskId={selectTask}
                sending={sending}
              />
              <DraftReviewPanel
                key={`${session.user.id}:${channelId}:drafts`}
                channelId={channelId}
              />
            </>
          ) : null}
          {messages.map((message) => (
            <View
              key={message.id}
              style={{
                padding: 12,
                backgroundColor:
                  message.role === "user" ? "#eff6ff" : "#f3f4f6",
                borderRadius: 8,
              }}
            >
              <Text style={{ fontWeight: "600" }}>
                {message.role === "user" ? "You" : "Scout"}
              </Text>
              <Text>
                {typeof message.content === "string"
                  ? message.content
                  : message.role === "tool"
                    ? "Tool result"
                    : ""}
              </Text>
            </View>
          ))}
        </ScrollView>
        {selectedTaskId ? (
          <View style={{ gap: 6 }}>
            <Text>Next message uses Odoo task #{selectedTaskId} once.</Text>
            <Button
              title="Clear selected task"
              disabled={sending}
              onPress={() => selectTask(null)}
            />
          </View>
        ) : null}
        {turnTaskId && sending ? (
          <Text>
            This turn selected Odoo task #{turnTaskId}; Scout rechecks access
            before sharing its summary.
          </Text>
        ) : null}
        <TextInput
          accessibilityLabel="Message Scout"
          multiline
          value={text}
          onChangeText={setText}
          editable={conversation?.active && !sending}
          placeholder="Message Scout"
          style={{
            borderWidth: 1,
            borderColor: "#9ca3af",
            borderRadius: 8,
            padding: 12,
            maxHeight: 140,
          }}
        />
        <Button
          title={sending ? "Sending…" : "Send"}
          disabled={!conversation?.active || !agent || !text.trim() || sending}
          onPress={() => void send()}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
