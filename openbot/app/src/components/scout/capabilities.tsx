import { useQuery } from "@tanstack/react-query";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { scoutCatalogQueryOptions } from "@/lib/scout-capabilities";

const labels = {
  available: "Available",
  requires_authorization: "Authorization required",
  unavailable: "Unavailable",
  not_connected: "Not connected",
} as const;

function CapabilityRow({
  title,
  status,
  detail,
}: {
  title: string;
  status: keyof typeof labels;
  detail: string;
}) {
  return (
    <li className="border-border border-b py-4 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground text-sm">{labels[status]}</span>
      </div>
      <p className="mt-1 text-muted-foreground text-sm">{detail}</p>
    </li>
  );
}

/** A read-only server projection. No status row grants access or connects an account. */
export function ScoutCapabilities({
  section,
}: {
  section: "skills" | "connections";
}) {
  const catalog = useQuery(scoutCatalogQueryOptions());
  const data = catalog.data;
  return (
    <PageShell
      title={section === "skills" ? "Scout capabilities" : "Connections"}
    >
      {catalog.isPending ? (
        <p role="status">Checking Scout's capabilities…</p>
      ) : null}
      {catalog.isError ? (
        <div role="alert" className="mt-4 space-y-3">
          <p>
            Couldn't check current capabilities. Connection status is
            unverified.
          </p>
          <Button onClick={() => void catalog.refetch()} variant="outline">
            Retry check
          </Button>
        </div>
      ) : null}
      {data && !catalog.isError ? (
        section === "skills" ? (
          <>
            <PageSection
              title="What you can use"
              description="Each task still uses your current access and sharing choices."
            >
              <ul>
                <CapabilityRow
                  title="Saved conversations"
                  status={data.skills.conversation}
                  detail="Chat with Scout and reopen your saved conversations."
                />
                <CapabilityRow
                  title="Selected Odoo task"
                  status={data.skills.odooSelectedTask}
                  detail="Choose one task in chat. Scout checks your Odoo access and asks before sharing its selected fields with the model."
                />
                <CapabilityRow
                  title="Delegated drafts"
                  status={data.skills.delegatedDraft}
                  detail="Submit a reviewed request to DSH and explicitly accept the returned draft."
                />
                <CapabilityRow
                  title="Voice input and read aloud"
                  status={
                    data.voice === "push_to_talk" ? "available" : "unavailable"
                  }
                  detail={
                    data.voice === "push_to_talk"
                      ? "Record a short message, review its transcript, then send. Read aloud plays a completed saved answer."
                      : "Local speech has not been enabled for this deployment."
                  }
                />
              </ul>
            </PageSection>
            <PageSection
              title="Skills and memory"
              description="Instructions guide an assistant; they do not connect an app or grant data access."
            >
              <p className="mt-3 text-muted-foreground text-sm">
                Custom skill installation and personal long-term memory are not
                enabled in this owned pilot. Saved conversation history is
                separate.
              </p>
            </PageSection>
          </>
        ) : (
          <PageSection
            title="Work apps"
            description="Connect each account directly to Scout when its adapter is ready. Connections in ChatGPT do not carry over."
          >
            <ul>
              {(
                [
                  ["outlookCalendar", "Outlook Calendar"],
                  ["outlookEmail", "Outlook Email"],
                  ["teams", "Microsoft Teams"],
                  ["sharePoint", "SharePoint"],
                  ["googleDrive", "Google Drive"],
                  ["github", "GitHub"],
                  ["fireflies", "Fireflies"],
                ] as const
              ).map(([key, title]) => (
                <CapabilityRow
                  key={key}
                  title={title}
                  status={data.integrations[key]}
                  detail="Scout has no connected account for this app. Setup will show the exact access requested before you authorize it."
                />
              ))}
            </ul>
          </PageSection>
        )
      ) : null}
    </PageShell>
  );
}
