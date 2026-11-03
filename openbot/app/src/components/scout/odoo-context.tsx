import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  consentOdooContextRelease,
  revokeOdooContext,
  revokeOdooContextRelease,
  scoutOdooKeys,
  scoutOdooStatus,
  submitOdooApiKey,
} from "@/lib/scout-odoo";

function expiryText(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "unknown";
}

type OdooTaskSelection = {
  selectedTaskId: string | null;
  contextTaskId: string | null;
  onSelectTaskId(taskId: string | null): void;
  busy: boolean;
};

type ScoutOdooContextProps = { agentId: string } & (
  | ({ mode?: "chat" } & OdooTaskSelection)
  | ({ mode: "connection" } & {
      [Key in keyof OdooTaskSelection]?: never;
    })
);

/** Shared account controls; chat alone adds the explicit next-turn task selector. */
export function ScoutOdooContext({
  agentId,
  mode = "chat",
  selectedTaskId,
  contextTaskId,
  onSelectTaskId,
  busy,
}: ScoutOdooContextProps) {
  const user = useQuery(currentUserQueryOptions());
  const cache = useQueryClient();
  const status = useQuery(scoutOdooStatus(user.data?.id ?? "", agentId));
  const keyFieldId = useId();
  const taskFieldId = useId();
  const [apiKey, setApiKey] = useState("");
  const [taskId, setTaskId] = useState("");
  const [keyPending, setKeyPending] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const connectionOnly = mode === "connection";
  const scopeKey = JSON.stringify([user.data?.id ?? "", agentId]);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const scopeCurrent = (expected: string) =>
    mounted.current && currentScope.current === expected;
  useEffect(() => {
    currentScope.current = scopeKey;
    setApiKey("");
    setTaskId("");
    setError(null);
    setNotice(null);
    setKeyPending(false);
    setActionPending(false);
  }, [scopeKey]);
  const current = connectionOnly && status.isError ? undefined : status.data;
  const displayedRoute = current?.route;
  const routeCurrent = Boolean(
    displayedRoute &&
      displayedRoute.provider === current?.provider &&
      Date.parse(displayedRoute.expiresAt) > Date.now(),
  );
  const recordActive = Boolean(
    current?.record?.active &&
      Date.parse(current.record.expiresAt) > Date.now(),
  );
  const releaseActive = Boolean(
    current?.release?.active &&
      Date.parse(current.release.expiresAt) > Date.now(),
  );
  const canRevokeStoredAccess = Boolean(
    current?.record?.credentialStored || releaseActive,
  );
  const canSelectTask = recordActive && releaseActive && routeCurrent;

  async function refreshStatus() {
    await cache.invalidateQueries({
      queryKey: scoutOdooKeys(user.data?.id ?? "", agentId),
    });
  }

  async function runAction(action: () => Promise<unknown>, success: string) {
    const expectedScope = scopeKey;
    setError(null);
    setNotice(null);
    setActionPending(true);
    try {
      await action();
      if (!scopeCurrent(expectedScope)) return;
      await refreshStatus();
      if (scopeCurrent(expectedScope)) setNotice(success);
    } catch (caught) {
      if (!scopeCurrent(expectedScope)) return;
      setError(
        caught instanceof Error ? caught.message : "The request failed.",
      );
      // Refresh the displayed route after a refusal, but require another
      // explicit click; never retry consent against a newer policy.
      await refreshStatus().catch(() => {});
    } finally {
      if (scopeCurrent(expectedScope)) setActionPending(false);
    }
  }

  async function changeRelease() {
    if (releaseActive) return revokeOdooContextRelease(agentId);
    if (!displayedRoute || !routeCurrent)
      throw new Error("Refresh and review the current model route first.");
    return consentOdooContextRelease(agentId, displayedRoute);
  }

  const controls = (
    <div className={connectionOnly ? "space-y-3" : "mt-3 space-y-3"}>
      <p className="text-sm text-muted-foreground">
        Connect your own qualified Odoo account. Scout reads one selected
        project task with your Odoo visibility and sends only its fixed summary
        to the configured model after separate consent.
      </p>
      {status.isPending ? <p role="status">Loading Odoo access…</p> : null}
      {status.isError ? <p role="alert">{status.error.message}</p> : null}
      {connectionOnly && status.isError ? (
        <p className="text-sm text-muted-foreground">
          Odoo access could not be verified for this profile. Refresh to retry.
        </p>
      ) : null}
      {current ? (
        <div aria-live="polite" className="space-y-1 text-sm">
          <p>
            Odoo access: {recordActive ? "active" : "not active"}
            {current.record
              ? `; ${current.record.projectCount} allowed projects; expires ${expiryText(current.record.expiresAt)}`
              : ""}
          </p>
          <p>
            Model sharing: {releaseActive ? "allowed" : "not allowed"} to{" "}
            {current.provider === "openrouter"
              ? "OpenRouter"
              : "the configured local provider"}
            {displayedRoute ? `, model ${displayedRoute.model}` : ""}
            {current.release
              ? `; expires ${expiryText(current.release.expiresAt)}`
              : ""}
          </p>
        </div>
      ) : null}
      {!connectionOnly || (current && !status.isPending) ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            const oneShotKey = apiKey;
            const expectedScope = scopeKey;
            setApiKey("");
            setError(null);
            setNotice(null);
            if (!oneShotKey) return;
            setKeyPending(true);
            void submitOdooApiKey(oneShotKey)
              .then(async () => {
                if (!scopeCurrent(expectedScope)) return;
                await refreshStatus();
                if (scopeCurrent(expectedScope))
                  setNotice("Scout saved an encrypted Odoo credential.");
              })
              .catch((caught: unknown) => {
                if (!scopeCurrent(expectedScope)) return;
                setError(
                  caught instanceof Error
                    ? caught.message
                    : "Couldn't save your Odoo access key.",
                );
              })
              .finally(() => {
                if (scopeCurrent(expectedScope)) setKeyPending(false);
              });
          }}
        >
          <label className="block text-sm" htmlFor={keyFieldId}>
            Odoo API key
          </label>
          <Input
            id={keyFieldId}
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            required
            maxLength={4096}
            disabled={keyPending || actionPending}
          />
          <p className="text-xs text-muted-foreground">
            The key is sent to Scout once and stored encrypted on Scout's
            server. Removing it here does not revoke the key in Odoo; revoke it
            there if you need to invalidate it upstream.
          </p>
          <Button type="submit" disabled={keyPending || actionPending}>
            {keyPending ? "Saving…" : "Save Odoo access key"}
          </Button>
        </form>
      ) : null}
      {recordActive && current ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {releaseActive
              ? `Only the fixed project-task summary may be sent to ${current.provider === "openrouter" ? "OpenRouter" : "the configured local provider"} when you select a task.`
              : `Allow the fixed project-task summary to reach ${current.provider === "openrouter" ? "OpenRouter" : "the configured local provider"} for this model route. This consent expires with the grant or model policy.`}
          </p>
          {!routeCurrent ? (
            <p className="text-sm text-muted-foreground">
              Refresh Odoo access and review the current model route before
              allowing task summaries.
            </p>
          ) : null}
          <Button
            type="button"
            variant={releaseActive ? "outline" : "default"}
            disabled={actionPending || (!releaseActive && !routeCurrent)}
            onClick={() =>
              void runAction(
                changeRelease,
                releaseActive
                  ? "Model-sharing consent withdrawn."
                  : "Model-sharing consent recorded.",
              )
            }
          >
            {releaseActive
              ? "Withdraw model-sharing consent"
              : "Allow task summaries to reach this model"}
          </Button>
        </div>
      ) : null}
      {recordActive && !connectionOnly ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!/^[1-9][0-9]{0,14}$/.test(taskId)) {
              setError("Enter a positive Odoo project task ID.");
              return;
            }
            setError(null);
            onSelectTaskId?.(taskId);
            setTaskId("");
          }}
        >
          <label className="block text-sm" htmlFor={taskFieldId}>
            Odoo project task ID
          </label>
          <Input
            id={taskFieldId}
            type="text"
            inputMode="numeric"
            pattern="[1-9][0-9]{0,14}"
            value={taskId}
            onChange={(event) => setTaskId(event.target.value)}
            disabled={!canSelectTask || actionPending || busy}
            maxLength={15}
          />
          <Button
            type="submit"
            disabled={!canSelectTask || actionPending || busy}
          >
            Use task once
          </Button>
          {!canSelectTask ? (
            <p className="text-xs text-muted-foreground">
              Grant model-sharing consent before selecting a task.
            </p>
          ) : null}
          {selectedTaskId ? (
            <p className="text-sm" role="status">
              Odoo project task #{selectedTaskId} is queued for your next
              message only. Scout rechecks access and Odoo visibility before the
              model receives a summary.
              <Button
                className="ml-2"
                type="button"
                variant="outline"
                onClick={() => onSelectTaskId?.(null)}
              >
                Clear selection
              </Button>
            </p>
          ) : null}
          {contextTaskId ? (
            <p className="text-sm" role="status">
              This turn includes Odoo project task #{contextTaskId}; Scout
              rechecks your grant and Odoo visibility before sending the summary
              to the model.
            </p>
          ) : null}
        </form>
      ) : null}
      {canRevokeStoredAccess ? (
        <Button
          type="button"
          variant="outline"
          disabled={actionPending || keyPending}
          onClick={() => {
            onSelectTaskId?.(null);
            void runAction(
              revokeOdooContext,
              "Scout's local Odoo grant and provider consent were revoked. The upstream Odoo API key remains valid until you revoke it in Odoo.",
            );
          }}
        >
          Revoke Scout's Odoo access
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        disabled={actionPending || keyPending}
        onClick={() => void runAction(async () => {}, "Odoo access refreshed.")}
      >
        Refresh Odoo access
      </Button>
      {error ? <p role="alert">{error}</p> : null}
      {notice && (!connectionOnly || !status.isError) ? (
        <p role="status">{notice}</p>
      ) : null}
    </div>
  );
  return connectionOnly ? (
    controls
  ) : (
    <details className="mx-3 my-2 rounded-lg border bg-card p-3 text-card-foreground">
      <summary className="cursor-pointer font-medium">Odoo context</summary>
      {controls}
    </details>
  );
}
