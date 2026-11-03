import type { ActionPolicy } from "../../computer/policy";
import type { EgressPolicy } from "../../computer/policy-network";
import { OwnedComputerError } from "./bindings";

export const PUBLIC_COMPUTER_URL = "https://example.org/" as const;
export const OWNED_COMPUTER_POLICY: ActionPolicy = {
  mode: "enforce",
  deny: [],
  allow: [
    'tool.name == "computer_navigate" && page.url == "https://example.org/"',
    '(tool.name == "computer_read" || tool.name == "computer_snapshot" || tool.name == "computer_screenshot") && (page.url == "https://example.org/" || page.url == "about:blank")',
  ],
};
export const OWNED_COMPUTER_EGRESS: EgressPolicy = {
  mode: "allowlist_only",
  rules: [{ type: "domain", value: "example.org" }],
};
export function publicComputerUrl(value: unknown, allowBlank = false): string {
  if (allowBlank && value === "about:blank") return "about:blank";
  if (typeof value !== "string")
    throw new OwnedComputerError("COMPUTER_ACCESS_DENIED");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OwnedComputerError("COMPUTER_ACCESS_DENIED");
  }
  if (parsed.href !== PUBLIC_COMPUTER_URL || parsed.username || parsed.password)
    throw new OwnedComputerError("COMPUTER_ACCESS_DENIED");
  return PUBLIC_COMPUTER_URL;
}
