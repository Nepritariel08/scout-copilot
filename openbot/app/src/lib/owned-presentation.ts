import type { DeploymentCapabilities } from "@/lib/deployment/queries";

// Optional voice is deferred while the owner pilot qualifies its core workflows.
// Backend readiness alone must not put unfinished voice controls into the chat.
const OWNED_VOICE_UI_ENABLED = false;

export function ownedVoiceUiAvailable(
  capabilities: DeploymentCapabilities | undefined,
): boolean {
  return (
    OWNED_VOICE_UI_ENABLED &&
    capabilities?.mode === "owned" &&
    capabilities.transcription === true &&
    capabilities.speechPlayback === true
  );
}

export function dictationUiAvailable(
  capabilities: DeploymentCapabilities | undefined,
): boolean {
  return (
    capabilities?.transcription === true &&
    (capabilities.mode !== "owned" || ownedVoiceUiAvailable(capabilities))
  );
}
