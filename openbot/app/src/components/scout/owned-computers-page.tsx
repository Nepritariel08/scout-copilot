import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  type OwnedComputerFrame,
  type OwnedComputerRead,
  OwnedComputerRequestError,
  openOwnedSamplePage,
  ownedComputerFleetQueryOptions,
  readOwnedSampleFrame,
} from "@/lib/computers/owned";

function Failure({ error, retry }: { error: unknown; retry(): void }) {
  const unavailable =
    error instanceof OwnedComputerRequestError && error.notConfigured;
  return (
    <div className="space-y-3" role={unavailable ? "status" : "alert"}>
      {unavailable ? <p className="font-medium">Not configured</p> : null}
      <p>
        {error instanceof Error
          ? error.message
          : "Your computers could not be loaded."}
      </p>
      {unavailable ? (
        <p className="text-sm text-muted-foreground">
          Ask your Scout administrator to set up the browser for this account.
        </p>
      ) : null}
      <Button variant="outline" onClick={retry}>
        {unavailable ? "Check setup" : "Retry computer check"}
      </Button>
    </div>
  );
}

/** Bounded owned browser flow; the licensed live-view/manual-control component stays separate. */
export function OwnedComputersPage() {
  const user = useQuery(currentUserQueryOptions());
  return (
    <PageShell
      title="Computers"
      description="Open a sample page in your Scout browser and see what it returns."
    >
      {user.isPending ? (
        <p role="status">Checking your account…</p>
      ) : user.isError || !user.data ? (
        <div role="alert" className="mt-4 space-y-3">
          <p>Your Scout sign-in could not be verified.</p>
          <Button variant="outline" onClick={() => void user.refetch()}>
            Refresh sign-in status
          </Button>
        </div>
      ) : (
        <OwnedComputerAccount key={user.data.id} userId={user.data.id} />
      )}
    </PageShell>
  );
}

function OwnedComputerAccount({ userId }: { userId: string }) {
  const fleet = useQuery(ownedComputerFleetQueryOptions(userId));
  const fieldId = useId();
  const [choice, setChoice] = useState("");
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<{
    read: OwnedComputerRead;
    frame: OwnedComputerFrame;
  } | null>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const activeTarget = useRef("");
  const selected = !fleet.isError
    ? fleet.data?.computers.find((value) => value.botId === choice)
    : undefined;
  const selectedId = selected?.botId ?? "";
  useEffect(() => {
    activeTarget.current = selectedId;
    generation.current += 1;
    controller.current?.abort();
    controller.current = null;
    setWorking(false);
    setFailure(null);
    setNotice(null);
    setResult(null);
    return () => {
      generation.current += 1;
      controller.current?.abort();
      controller.current = null;
    };
  }, [selectedId]);

  async function openSample() {
    if (!selected || controller.current) return;
    const target = selected.botId;
    const next = new AbortController();
    const version = ++generation.current;
    controller.current = next;
    const current = () =>
      generation.current === version &&
      activeTarget.current === target &&
      !next.signal.aborted;
    setWorking(true);
    setFailure(null);
    setNotice(null);
    setResult(null);
    try {
      const read = await openOwnedSamplePage(target, next.signal);
      if (!current()) return;
      const frame = await readOwnedSampleFrame(read, next.signal);
      if (current()) setResult({ read, frame });
    } catch (error) {
      if (current()) setFailure(error);
    } finally {
      if (generation.current === version) {
        controller.current = null;
        setWorking(false);
      }
    }
  }

  function cancel() {
    generation.current += 1;
    controller.current?.abort();
    controller.current = null;
    setWorking(false);
    setResult(null);
    setFailure(null);
    setNotice("Request cancelled. The sample page may already have opened.");
  }

  return (
    <PageSection title="Your Scout browser">
      {fleet.isPending ? (
        <p role="status">Checking your computers…</p>
      ) : fleet.isError ? (
        <Failure error={fleet.error} retry={() => void fleet.refetch()} />
      ) : fleet.data?.computers.length ? (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Choose one of the profiles available to your account. The sample
            opens example.org and returns its title, text and saved picture.
          </p>
          <label className="block text-sm font-medium" htmlFor={fieldId}>
            Scout computer
          </label>
          <select
            id={fieldId}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={selectedId}
            onChange={(event) => setChoice(event.target.value)}
          >
            <option value="">Choose a computer</option>
            {fleet.data.computers.map((computer) => (
              <option key={computer.botId} value={computer.botId}>
                {computer.botId}
              </option>
            ))}
          </select>
          {selected ? (
            <Item variant="outline">
              <ItemContent>
                <ItemTitle>{selected.botId}</ItemTitle>
                <ItemDescription>
                  {selected.running
                    ? "Browser running at the last check."
                    : "Browser starts when you open the sample page."}
                </ItemDescription>
              </ItemContent>
            </Item>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!selected || working || fleet.isFetching}
              onClick={() => void openSample()}
            >
              {working ? "Opening sample page…" : "Open sample page"}
            </Button>
            {working ? (
              <Button variant="outline" onClick={cancel}>
                Cancel sample request
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={working || fleet.isFetching}
              onClick={() => void fleet.refetch()}
            >
              Refresh computers
            </Button>
          </div>
          {notice ? <p role="status">{notice}</p> : null}
          {failure ? (
            <Failure error={failure} retry={() => void fleet.refetch()} />
          ) : null}
          {result && result.read.computerId === selectedId ? (
            <section
              className="space-y-3 rounded-lg border p-4"
              aria-label="Sample page result"
            >
              <h3 className="font-medium">
                {result.read.title || "Sample page"}
              </h3>
              <p className="text-xs text-muted-foreground">
                {result.read.url} · Observed{" "}
                {new Date(result.read.observedAt).toLocaleString()}
              </p>
              <p className="text-xs text-muted-foreground">
                {result.read.untrusted}
              </p>
              <pre className="whitespace-pre-wrap break-words text-sm">
                {result.read.text}
              </pre>
              {result.read.truncated ? (
                <p className="text-sm text-muted-foreground">
                  Only part of the page text is shown.
                </p>
              ) : null}
              {result.frame ? (
                <figure className="overflow-hidden rounded-lg border">
                  <img
                    alt="Saved sample page snapshot"
                    className="h-auto w-full"
                    src={`data:image/png;base64,${result.frame.frame}`}
                  />
                  <figcaption className="p-2 text-xs text-muted-foreground">
                    Saved when the sample page was opened.
                  </figcaption>
                </figure>
              ) : (
                <p className="text-sm text-muted-foreground">
                  The saved picture is unavailable. The returned page text is
                  shown above.
                </p>
              )}
            </section>
          ) : null}
        </div>
      ) : (
        <p>
          No computer is available for your current account. Ask your Scout
          administrator to check your access.
        </p>
      )}
    </PageSection>
  );
}
