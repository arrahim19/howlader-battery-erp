import { Redirect, useLocalSearchParams } from "expo-router";
const routes: Record<string, string> = {
  sale: "sales/new",
  purchase: "purchases/new",
  customer: "customers/new",
  supplier: "suppliers/new",
  expense: "accounts/transactions",
  product: "inventory",
  replacement: "replacements/new",
};
export default function LegacyNew() {
  const { kind } = useLocalSearchParams<{ kind: string }>();
  return (
    <Redirect
      href={
        ("/workspace/" +
          (routes[kind] ?? "dashboard")) as "/workspace/dashboard"
      }
    />
  );
}
