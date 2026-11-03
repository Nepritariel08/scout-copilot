import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { ScoutCapabilities } from "./capabilities";
import { ScoutOdooContext } from "./odoo-context";

/** The existing Odoo enrollment and consent flow, without selecting or sending a chat task. */
export function OwnedOdooConnections() {
  const user = useQuery(currentUserQueryOptions());
  const roster = agentListQueryOptions();
  const profiles = useQuery({
    queryKey: [...roster.queryKey, user.data?.id ?? ""] as const,
    queryFn: async (context) => {
      if (typeof roster.queryFn !== "function")
        throw new Error("Scout profiles could not be loaded.");
      return roster.queryFn({ ...context, queryKey: roster.queryKey });
    },
    enabled: Boolean(user.data && !user.isError),
    retry: false,
  });
  const fieldId = useId();
  const [choice, setChoice] = useState<{
    userId: string;
    profileId: string;
  } | null>(null);
  const available = (profiles.data ?? []).filter(
    (profile) => profile.builtIn && !profile.hidden,
  );
  const selected =
    choice?.userId === user.data?.id
      ? available.find((profile) => profile.id === choice?.profileId)
      : undefined;
  const accountReady = Boolean(user.data && !user.isError);

  return (
    <PageShell title="Connections">
      <PageSection
        title="Odoo"
        description="Manage your Odoo access and review model sharing for the Scout profile you use in chat."
      >
        <div className="mt-3 space-y-4">
          <p className="text-sm text-muted-foreground">
            Signing in to Scout identifies you. Connect your work accounts
            separately, then choose and send a selected task from chat.
          </p>
          {user.isPending ? <p role="status">Checking your account…</p> : null}
          {user.isError || (!user.isPending && !user.data) ? (
            <div className="space-y-2" role="alert">
              <p>Sign in to Scout before managing an Odoo connection.</p>
              <Button variant="outline" onClick={() => void user.refetch()}>
                Refresh sign-in status
              </Button>
            </div>
          ) : null}
          {accountReady && profiles.isPending ? (
            <p role="status">Loading your Scout profiles…</p>
          ) : null}
          {accountReady && profiles.isError ? (
            <div className="space-y-2" role="alert">
              <p>
                Couldn't verify your Scout profiles. Odoo access is unverified.
              </p>
              <Button variant="outline" onClick={() => void profiles.refetch()}>
                Retry profiles
              </Button>
            </div>
          ) : null}
          {accountReady && !profiles.isPending && !profiles.isError ? (
            available.length ? (
              <>
                <div className="space-y-2">
                  <label
                    className="block text-sm font-medium"
                    htmlFor={fieldId}
                  >
                    Scout profile
                  </label>
                  <select
                    id={fieldId}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={selected?.id ?? ""}
                    onChange={(event) =>
                      setChoice({
                        userId: user.data?.id ?? "",
                        profileId: event.target.value,
                      })
                    }
                  >
                    <option value="">Choose the profile you use in chat</option>
                    {available.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Saving or revoking Odoo access applies to your Scout
                    account. Model sharing requires separate consent for this
                    profile's current provider and model.
                  </p>
                </div>
                {selected && user.data ? (
                  <ScoutOdooContext
                    key={JSON.stringify([user.data.id, selected.id])}
                    agentId={selected.id}
                    mode="connection"
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Choose a profile to check its current Odoo access.
                  </p>
                )}
              </>
            ) : (
              <p>No built-in Scout profiles are available for this account.</p>
            )
          ) : null}
        </div>
      </PageSection>
      <ScoutCapabilities section="connections" embedded />
    </PageShell>
  );
}
