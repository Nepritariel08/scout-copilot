import { expoClient } from "@better-auth/expo/client";
import { createAuthClient } from "better-auth/react";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";

const configured = Constants.expoConfig?.extra?.scoutServerUrl;
if (!configured)
  throw new Error(
    "Set EXPO_PUBLIC_SERVER_URL to your Scout deployment before building the native app.",
  );
const endpoint = new URL(configured);
if (
  endpoint.protocol !== "https:" &&
  !(__DEV__ && endpoint.protocol === "http:")
)
  throw new Error("Scout native sign-in requires HTTPS.");
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
  throw new Error(
    "Use the public deployment URL without credentials or query parameters.",
  );
export const serverUrl = endpoint.origin;
export const authClient = createAuthClient({
  baseURL: serverUrl,
  plugins: [
    expoClient({
      scheme: "scoutmobile",
      storagePrefix: `scout-${endpoint.host.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
      storage: SecureStore,
    }),
  ],
});
export async function signIn() {
  const result = await authClient.signIn.social({
    provider: "microsoft",
    callbackURL: "scoutmobile://",
  });
  if (result.error)
    throw new Error(
      result.error.message ?? "Could not sign in with Microsoft Entra.",
    );
}
