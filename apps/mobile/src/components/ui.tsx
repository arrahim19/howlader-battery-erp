import type { ReactNode } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Redirect, router, useIsFocused } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useSession } from "../lib/session";

export const colors = {
  ink: "#12272c",
  green: "#008651",
  muted: "#71818a",
  line: "#e3e9e7",
  background: "#f5f8f6",
  pale: "#e7f5ed",
  red: "#ba3434",
};
export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 18,
    backgroundColor: "white",
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  title: { color: colors.ink, fontSize: 23, fontWeight: "800" },
  subtitle: { color: colors.muted, fontSize: 12, marginTop: 4 },
  content: { padding: 18, gap: 14, paddingBottom: 35 },
  card: {
    backgroundColor: "white",
    borderRadius: 17,
    padding: 17,
    borderWidth: 1,
    borderColor: colors.line,
    gap: 10,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  between: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  heading: { color: colors.ink, fontSize: 17, fontWeight: "700" },
  text: { color: colors.ink, fontSize: 14, lineHeight: 21 },
  muted: { color: colors.muted, fontSize: 12, lineHeight: 19 },
  amount: { color: colors.ink, fontSize: 22, fontWeight: "800" },
  label: { color: "#41565a", fontSize: 12, fontWeight: "600", marginBottom: 7 },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: "#d6e0dc",
    borderRadius: 11,
    backgroundColor: "white",
    paddingHorizontal: 13,
    paddingVertical: 11,
    color: colors.ink,
    fontSize: 16,
  },
  button: {
    minHeight: 47,
    borderRadius: 11,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    backgroundColor: colors.green,
  },
  buttonText: { color: "white", fontWeight: "700", fontSize: 14 },
  badge: {
    alignSelf: "flex-start",
    borderRadius: 7,
    paddingHorizontal: 9,
    paddingVertical: 4,
    backgroundColor: colors.pale,
  },
  badgeText: { color: colors.green, fontSize: 11, fontWeight: "700" },
  section: { gap: 12 },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: 5 },
});
export function Button({
  title,
  onPress,
  busy,
  disabled,
  variant = "primary",
  icon,
}: {
  title: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  variant?: "primary" | "outline" | "danger";
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === "outline" && {
          backgroundColor: "white",
          borderColor: colors.line,
          borderWidth: 1,
        },
        variant === "danger" && { backgroundColor: colors.red },
        { opacity: disabled || busy ? 0.5 : pressed ? 0.8 : 1 },
      ]}
    >
      {busy ? (
        <ActivityIndicator
          color={variant === "outline" ? colors.green : "white"}
        />
      ) : icon ? (
        <Ionicons
          name={icon}
          size={18}
          color={variant === "outline" ? colors.green : "white"}
        />
      ) : null}
      <Text
        style={[
          styles.buttonText,
          variant === "outline" && { color: colors.ink },
        ]}
      >
        {title}
      </Text>
    </Pressable>
  );
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor="#9aa7ac"
        style={styles.input}
        {...props}
      />
    </View>
  );
}
export function Notice({
  children,
  kind = "error",
}: {
  children: ReactNode;
  kind?: "error" | "success";
}) {
  return (
    <View
      accessibilityRole="alert"
      style={{
        borderRadius: 11,
        padding: 13,
        backgroundColor: kind === "error" ? "#fff0ec" : colors.pale,
      }}
    >
      <Text
        style={{
          color: kind === "error" ? "#a43d28" : colors.green,
          fontSize: 13,
          lineHeight: 20,
        }}
      >
        {children}
      </Text>
    </View>
  );
}
export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}
export function Badge({ children }: { children: ReactNode }) {
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{children}</Text>
    </View>
  );
}
export function Loading() {
  return (
    <View style={{ padding: 36, alignItems: "center", gap: 12 }}>
      <ActivityIndicator size="large" color={colors.green} />
      <Text style={styles.muted}>Loading your shop…</Text>
    </View>
  );
}
export function Empty({ text = "No records yet." }: { text?: string }) {
  return (
    <Card>
      <Ionicons name="file-tray-outline" size={30} color={colors.muted} />
      <Text style={styles.muted}>{text}</Text>
    </Card>
  );
}
export function Page({
  title,
  children,
  back,
  action,
  loading,
  onRefresh,
}: {
  title: string;
  children: ReactNode;
  back?: boolean;
  action?: ReactNode;
  loading?: boolean;
  onRefresh?: () => void;
}) {
  const { user, loading: restoring, syncStatus } = useSession();
  const focused = useIsFocused();
  if (restoring)
    return (
      <SafeAreaView style={styles.page}>
        <Loading />
      </SafeAreaView>
    );
  if (!user) return <Redirect href="/login" />;
  return (
    <SafeAreaView
      edges={["top", "left", "right"]}
      style={styles.page}
      accessibilityElementsHidden={!focused}
      importantForAccessibility={focused ? "auto" : "no-hide-descendants"}
      aria-hidden={!focused}
    >
      <View style={styles.header}>
        {back ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={() =>
              router.canGoBack() ? router.back() : router.replace("/(tabs)")
            }
            style={{ padding: 5 }}
          >
            <Ionicons name="arrow-back" size={23} color={colors.ink} />
          </Pressable>
        ) : (
          <Ionicons name="battery-charging" size={28} color={colors.green} />
        )}
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>
            {user.shop?.branchName ?? "Shop"} ·{" "}
            {user.shop?.name ?? "Hawlader Battery"}
          </Text>
        </View>
        {action}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sync & local data"
        onPress={() => router.push("/sync")}
        style={{
          paddingHorizontal: 20,
          paddingVertical: 9,
          backgroundColor: syncStatus.blocked ? "#fff0ec" : colors.pale,
        }}
      >
        <Text style={styles.muted}>
          {syncStatus.syncing
            ? "Syncing…"
            : syncStatus.offline
              ? "Offline · saved local data"
              : "Local database · connected"}
          {syncStatus.pending ? ` · ${syncStatus.pending} waiting` : ""}
          {syncStatus.blocked ? ` · ${syncStatus.blocked} needs review` : ""}
        </Text>
      </Pressable>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
          refreshControl={
            onRefresh ? (
              <RefreshControl
                refreshing={Boolean(loading)}
                onRefresh={onRefresh}
                tintColor={colors.green}
              />
            ) : undefined
          }
        >
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
