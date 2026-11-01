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
  const activeScope = useRef({ userId: session?.user.id, channelId });
  activeScope.current = { userId: session?.user.id, channelId };
  const previousScope = useRef({ userId: session?.user.id, channelId });

  const userView = dataForSignedInUser(view, session?.user.id);
  const conversationData =
    userView?.channelId === channelId ? userView : undefined;
  const conversation = conversationData?.conversation;
  const agent = conversationData?.agent;
  const messages = conversationData?.messages ?? [];

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
      if (!channelId || !userId) return undefined;
      setLoading(true);
      if (!options?.preserveError) setError("");
      try {
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
        setView({
          userId,
          value: {
            channelId,
            conversation: channel,
            agent: selectedAgent,
            messages: history,
          },
        });
        return history;
      } catch (failure) {
        if (!options?.preserveError)
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not load this Scout conversation.",
          );
        return undefined;
      } finally {
        setLoading(false);
      }
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
    if (!conversation || !agent || !userId || !text.trim() || sending) return;
    const submittedText = text.trim();
    const placeholderId = Crypto.randomUUID();
    const run = buildOwnedRunInput({
      threadId: conversation.threadId,
      history: messages,
      text: submittedText,
      createId: () => Crypto.randomUUID(),
    });
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
