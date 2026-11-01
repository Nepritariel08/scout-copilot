import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Button,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import { api, type Conversation, type ScoutAgent, scopedApi } from "../src/api";
import { authClient, signIn } from "../src/auth";
import { clearForIdentityChange, dataForSignedInUser } from "../src/owned-chat";

type Capabilities = { authProviders?: string[] };
type HomeData = { agents: ScoutAgent[]; channels: Conversation[] };

export default function Home() {
  const { data: session, isPending } = authClient.useSession();
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [homeData, setHomeData] = useState<{
    userId: string;
    value: HomeData;
  }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(false);
  const activeUserId = useRef(session?.user.id);
  activeUserId.current = session?.user.id;
  const userId = session?.user.id ?? "";
  const isCurrent = () =>
    mounted.current && Boolean(userId) && activeUserId.current === userId;
  const client = scopedApi({ userId, isCurrent });
  const microsoftAvailable = capabilities?.authProviders?.includes("microsoft");
  const currentHomeData = dataForSignedInUser(homeData, session?.user.id);
  const agents = currentHomeData?.agents ?? [];
  const channels = currentHomeData?.channels ?? [];
  const scoutAgent = useMemo(
    () => agents.find((agent) => agent.builtIn),
    [agents],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setHomeData((current) => clearForIdentityChange(current, session?.user.id));
  }, [session?.user.id]);

  useEffect(() => {
    if (session) return;
    let current = true;
    void api<Capabilities>("/api/capabilities")
      .then((value) => {
        if (current) setCapabilities(value);
      })
      .catch((failure) => {
        if (current)
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not load Scout sign-in options.",
          );
      });
    return () => {
      current = false;
    };
  }, [session]);

  const refresh = useCallback(async () => {
    const userId = session?.user.id;
    if (!userId) return;
    const isCurrent = () => mounted.current && activeUserId.current === userId;
    const client = scopedApi({ userId, isCurrent });
    setRefreshing(true);
    setError("");
    try {
      const [agentResult, channelPage] = await Promise.all([
        client<{ agents: ScoutAgent[] }>("/api/agents"),
        client<{ channels: Conversation[] }>("/api/channels?limit=50"),
      ]);
      if (!isCurrent()) return;
      setHomeData({
        userId,
        value: { agents: agentResult.agents, channels: channelPage.channels },
      });
    } catch (failure) {
      if (!isCurrent()) return;
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not load Scout conversations.",
      );
    } finally {
      if (isCurrent()) setRefreshing(false);
    }
  }, [session?.user.id]);

  useFocusEffect(
    useCallback(() => {
      if (!session?.user.id) return;
      void refresh();
    }, [refresh, session?.user.id]),
  );

  async function createConversation() {
    if (!scoutAgent || busy || !isCurrent()) return;
    setBusy(true);
    setError("");
    try {
      const result = await client<{ channel: Conversation }>("/api/channels", {
        method: "POST",
        body: { agentIds: [scoutAgent.id] },
      });
      if (!isCurrent()) return;
      router.push({
        pathname: "/conversation",
        params: { channelId: result.channel.id },
      });
    } catch (failure) {
      if (!isCurrent()) return;
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not create a Scout conversation.",
      );
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setError("");
    try {
      const result = await authClient.signOut();
      if (result.error)
        throw new Error(result.error.message ?? "Could not sign out.");
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Could not sign out.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (isPending) return <ActivityIndicator style={{ marginTop: 40 }} />;

  return (
    <ScrollView
      contentContainerStyle={{ padding: 20, gap: 16 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void refresh()}
        />
      }
    >
      <Text style={{ fontSize: 26, fontWeight: "700" }}>Scout</Text>
      <Text style={{ color: "#475467" }}>
        Private conversations with your approved Scout assistant.
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: "#b42318" }}>
          {error}
        </Text>
      ) : null}
      {!session ? (
        <View style={{ gap: 12 }}>
          <Text>Sign in with your invited organization account.</Text>
          {microsoftAvailable ? (
            <Button
              disabled={busy}
              title="Continue with Microsoft Entra"
              onPress={() => {
                setBusy(true);
                setError("");
                void signIn()
                  .catch((failure) =>
                    setError(
                      failure instanceof Error
                        ? failure.message
                        : "Could not sign in with Microsoft Entra.",
                    ),
                  )
                  .finally(() => setBusy(false));
              }}
            />
          ) : (
            <Text>
              Microsoft Entra sign-in is not enabled on this Scout server yet.
            </Text>
          )}
        </View>
      ) : (
        <>
          <Text style={{ color: "#475467" }}>
            Signed in as {session.user.name ?? session.user.email}
          </Text>
          <Button
            disabled={busy || !scoutAgent}
            title={busy ? "Opening…" : "New Scout conversation"}
            onPress={() => void createConversation()}
          />
          {!scoutAgent ? (
            <Text>
              No built-in Scout assistant is available for this account.
            </Text>
          ) : null}
          <Text style={{ fontSize: 20, fontWeight: "600" }}>Conversations</Text>
          {channels.map((channel) => (
            <Button
              key={channel.id}
              title={`${channel.name}${channel.active ? "" : " (inactive)"}`}
              disabled={!channel.active}
              onPress={() =>
                router.push({
                  pathname: "/conversation",
                  params: { channelId: channel.id },
                })
              }
            />
          ))}
          {!refreshing && channels.length === 0 && !error ? (
            <Text>
              No conversations yet. Start one with the Scout assistant.
            </Text>
          ) : null}
          <Button
            disabled={busy}
            title="Sign out"
            onPress={() => void signOut()}
          />
        </>
      )}
    </ScrollView>
  );
}
