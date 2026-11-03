import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { client } from "@/lib/client";

const availability = z.enum([
  "available",
  "requires_authorization",
  "unavailable",
]);
const disconnected = z.literal("not_connected");
const catalogSchema = z.strictObject({
  version: z.literal(1),
  skills: z.strictObject({
    conversation: z.literal("available"),
    odooSelectedTask: availability,
    delegatedDraft: availability,
  }),
  integrations: z.strictObject({
    outlookCalendar: disconnected,
    outlookEmail: disconnected,
    teams: disconnected,
    sharePoint: disconnected,
    googleDrive: disconnected,
    github: disconnected,
    fireflies: disconnected,
  }),
  voice: z.enum(["unavailable", "push_to_talk"]),
  modelTools: z.literal("protected_policy_opt_in"),
});

export type ScoutCatalog = z.infer<typeof catalogSchema>;

export function scoutCatalogQueryOptions() {
  return queryOptions({
    queryKey: ["scout", "capability-catalog"],
    staleTime: 0,
    retry: false,
    queryFn: async (): Promise<ScoutCatalog> => {
      const response = await client("/api/scout/capabilities", {
        fallback: "Couldn't check Scout's capabilities.",
      });
      return catalogSchema.parse(await response.json());
    },
  });
}
