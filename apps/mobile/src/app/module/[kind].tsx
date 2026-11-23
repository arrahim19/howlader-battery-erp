import { Redirect, useLocalSearchParams } from "expo-router";
export default function LegacyModule() {
  const { kind } = useLocalSearchParams<{ kind: string }>();
  return (
    <Redirect
      href={
        ("/workspace/" +
          (kind === "expenses"
            ? "accounts/transactions"
            : kind)) as "/workspace/dashboard"
      }
    />
  );
}
