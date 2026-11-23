import { Redirect, useLocalSearchParams } from "expo-router";
export default function LegacyLedger() {
  const { kind } = useLocalSearchParams<{ kind: string }>();
  return (
    <Redirect
      href={
        kind === "customer"
          ? "/workspace/customers/ledger"
          : "/workspace/suppliers/ledger"
      }
    />
  );
}
