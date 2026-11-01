import { Stack } from "expo-router";

export default function Layout() {
  return (
    <Stack screenOptions={{ headerBackTitle: "Back" }}>
      <Stack.Screen name="index" options={{ title: "Scout" }} />
      <Stack.Screen name="conversation" options={{ title: "Conversation" }} />
    </Stack>
  );
}
