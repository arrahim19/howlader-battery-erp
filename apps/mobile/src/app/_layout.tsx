import { Slot, useGlobalSearchParams, usePathname } from "expo-router";
import { View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider } from "../lib/session";
import { SharedWorkspace } from "../components/shared-workspace";

function WorkspaceHost() {
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key !== "path" && typeof value === "string") search.set(key, value);
  }
  const query = search.toString();
  return (
    <View style={{ flex: 1 }}>
      {/* Keep native action replies connected through login and navigation. */}
      <SharedWorkspace
        pathname={
          pathname.replace(/^\/workspace/, "") + (query ? "?" + query : "")
        }
      />
      <View style={{ display: "none" }}>
        <Slot />
      </View>
    </View>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="dark" />
        <WorkspaceHost />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
