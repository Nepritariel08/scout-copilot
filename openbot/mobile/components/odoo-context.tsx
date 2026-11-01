import * as Linking from "expo-linking";
import { useEffect, useRef, useState } from "react";
import { Button, Text, TextInput, View } from "react-native";
import { serverUrl } from "../src/api";
import {
  type AuthenticatedApi,
  canSelectOdooTask,
  changeOdooRelease,
  type OdooContextStatus,
  readOdooContext,
  validOdooTaskId,
  webContextSetupUrl,
} from "../src/scout-work";

/** Mounted with a user/channel/agent key by the conversation screen. */
export function OdooContextPanel({
  agentId,
  channelId,
  selectedTaskId,
  onSelectTaskId,
  sending,
  client,
}: {
  agentId: string;
  channelId: string;
  selectedTaskId: string | null;
  onSelectTaskId(taskId: string | null): void;
  sending: boolean;
  client: AuthenticatedApi;
}) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<OdooContextStatus>();
  const [taskId, setTaskId] = useState("");
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

  const recordActive = Boolean(
    status?.record?.active && Date.parse(status.record.expiresAt) > Date.now(),
  );
  const releaseActive = Boolean(
    status?.release?.active &&
      Date.parse(status.release.expiresAt) > Date.now(),
  );
  const canSelect = canSelectOdooTask(status);
  const provider =
    status?.provider === "openrouter"
      ? "OpenRouter"
      : "the configured local provider";

  async function loadStatus() {
    const next = await readOdooContext(client, agentId);
    if (!alive.current) return;
    setStatus(next);
    if (!canSelectOdooTask(next)) onSelectTaskId(null);
  }

  async function run(action?: boolean) {
    if (inFlight.current || sending) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    setNotice("");
    if (action === false) onSelectTaskId(null);
    try {
      if (action !== undefined)
        await changeOdooRelease(client, agentId, action, status?.route);
      if (!alive.current) return;
      await loadStatus();
      if (alive.current && action !== undefined)
        setNotice(
          action
            ? "Model-sharing consent recorded."
            : "Model-sharing consent withdrawn.",
        );
    } catch (caught) {
      if (alive.current) {
        setStatus(undefined);
        onSelectTaskId(null);
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not load Odoo access.",
        );
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setPending(false);
    }
  }

  async function openSetup() {
    try {
      await Linking.openURL(webContextSetupUrl(serverUrl, channelId));
    } catch {
      if (alive.current) setError("Could not open Scout web setup.");
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
        title={expanded ? "Hide Odoo context" : "Odoo context"}
        onPress={() => {
          setExpanded(!expanded);
          if (!expanded) void run();
        }}
      />
      {expanded ? (
        <>
          <Text>
            Select one project task for your next message. Scout rechecks your
            grants and Odoo visibility before releasing its fixed summary.
          </Text>
          {pending ? (
            <Text accessibilityLiveRegion="polite">Checking Odoo access…</Text>
          ) : null}
          {status ? (
            <>
              <Text>
                Odoo access: {recordActive ? "active" : "not active"}
                {status.record
                  ? `; ${status.record.projectCount} allowed projects`
                  : ""}
                .
              </Text>
              <Text>
                Model sharing: {releaseActive ? "allowed" : "not allowed"} to{" "}
                {provider}, model {status.route.model}.
              </Text>
              {recordActive && !releaseActive ? (
                <>
                  <Text>
                    Allow only the fixed project-task summary to reach{" "}
                    {provider}, model {status.route.model}, for this model
                    route. Consent expires with its grant or model policy.
                  </Text>
                  <Button
                    title="Allow task summaries to reach this model"
                    disabled={pending || sending}
                    onPress={() => void run(true)}
                  />
                </>
              ) : null}
              {releaseActive ? (
                <Button
                  title="Withdraw model-sharing consent"
                  disabled={pending || sending}
                  onPress={() => void run(false)}
                />
              ) : null}
            </>
          ) : null}
          <TextInput
            accessibilityLabel="Odoo project task ID"
            placeholder="Odoo project task ID"
            keyboardType="number-pad"
            maxLength={15}
            value={taskId}
            onChangeText={setTaskId}
            editable={canSelect && !pending && !sending}
            style={{
              borderWidth: 1,
              borderColor: "#9ca3af",
              borderRadius: 6,
              padding: 10,
            }}
          />
          <Button
            title="Use task for next message"
            disabled={!canSelect || pending || sending}
            onPress={() => {
              const selected = taskId.trim();
              if (!validOdooTaskId(selected)) {
                setError(
                  "Enter a positive Odoo project task ID, up to 15 digits.",
                );
                return;
              }
              setError("");
              onSelectTaskId(selected);
              setTaskId("");
            }}
          />
          {!canSelect ? (
            <Text>
              Active Odoo access and separate model-sharing consent are required
              to select a task.
            </Text>
          ) : null}
          {selectedTaskId ? (
            <>
              <Text accessibilityLiveRegion="polite">
                Task #{selectedTaskId} is selected for your next message only.
              </Text>
              <Button
                title="Clear task selection"
                disabled={sending}
                onPress={() => onSelectTaskId(null)}
              />
            </>
          ) : null}
          <Text>
            Manage your Odoo credential in authenticated Scout web setup.
          </Text>
          <Button
            title="Open Scout web setup"
            onPress={() => void openSetup()}
          />
          <Button
            title="Refresh Odoo access"
            disabled={pending || sending}
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
