import { z } from "zod";

/** Product facts only. Never identities, credentials or business records. */
export const ownedCatalogSchema = z.strictObject({
  version: z.literal(1),
  skills: z.strictObject({
    conversation: z.literal("available"),
    odooSelectedTask: z.enum(["requires_authorization", "unavailable"]),
    delegatedDraft: z.enum(["requires_authorization", "unavailable"]),
  }),
  integrations: z.strictObject({
    outlookCalendar: z.literal("not_connected"),
    outlookEmail: z.literal("not_connected"),
    teams: z.literal("not_connected"),
    sharePoint: z.literal("not_connected"),
    googleDrive: z.literal("not_connected"),
    github: z.literal("not_connected"),
    fireflies: z.literal("not_connected"),
  }),
  voice: z.enum(["unavailable", "push_to_talk"]),
  modelTools: z.literal("protected_policy_opt_in"),
});
export type OwnedCatalog = z.infer<typeof ownedCatalogSchema>;

/** Adapter availability is not a user's data grant or permission to execute a workflow. */
export function ownedCatalog(options: {
  odooSelectedTask: boolean;
  delegatedDraft: boolean;
  speech?: boolean;
}): OwnedCatalog {
  return {
    version: 1,
    skills: {
      conversation: "available",
      odooSelectedTask: options.odooSelectedTask
        ? "requires_authorization"
        : "unavailable",
      delegatedDraft: options.delegatedDraft
        ? "requires_authorization"
        : "unavailable",
    },
    integrations: {
      outlookCalendar: "not_connected",
      outlookEmail: "not_connected",
      teams: "not_connected",
      sharePoint: "not_connected",
      googleDrive: "not_connected",
      github: "not_connected",
      fireflies: "not_connected",
    },
    voice: options.speech === true ? "push_to_talk" : "unavailable",
    modelTools: "protected_policy_opt_in",
  };
}
