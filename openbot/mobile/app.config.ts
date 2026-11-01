import type { ExpoConfig } from "expo/config";

const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
const serverUrl = process.env.EXPO_PUBLIC_SERVER_URL;
const config: ExpoConfig = {
  name: "Scout",
  slug: "scout-mobile",
  version: "0.1.0",
  scheme: "scoutmobile",
  ios: {
    bundleIdentifier: "ph.somethingsomewhere.scout",
    supportsTablet: true,
  },
  android: { package: "ph.somethingsomewhere.scout" },
  plugins: ["expo-router", "expo-secure-store"],
  extra: {
    ...(serverUrl ? { scoutServerUrl: serverUrl } : {}),
    ...(projectId ? { eas: { projectId } } : {}),
  },
};
export default config;
