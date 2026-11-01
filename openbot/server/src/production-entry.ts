/*
 * Bun resolves eventsource@3 through its `bun` export before its `require` export. The MCP SDK's
 * CommonJS SSE transport still requires eventsource, so the production process evaluates the ESM
 * module once before the runtime can reach that CJS require.
 */
import "eventsource";

const mode = process.env.SCOUT_RUNTIME_MODE?.trim() || "intelligence";
if (mode === "owned") {
  // The owned composition exports no vendor telemetry; set before importing its runtime.
  process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
  process.env.DO_NOT_TRACK = "1";
  const { startOwnedScout } = await import("./scout/owned/start");
  await startOwnedScout();
} else if (mode === "intelligence") {
  await import("./index");
} else {
  throw new Error("SCOUT_RUNTIME_MODE must be intelligence or owned.");
}
