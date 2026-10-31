/** Public draft receipt only. Requester credentials, binding and prompt stay server-side. */
export type ScoutTaskView = {
  id: string;
  channelId: string;
  sourceId: string;
  title: string;
  state:
    | "submission_unknown"
    | "queued"
    | "running"
    | "review_required"
    | "completed"
    | "cancelled"
    | "failed";
  workItemId: number | null;
  revision: number | null;
  result: string | null;
  draftDigest: string | null;
  accepted: boolean;
  errorCode: string | null;
  updatedAt: string;
};
