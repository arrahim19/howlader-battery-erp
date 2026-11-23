import type { Metadata } from "next";
import { AccountRecoveryForm } from "@/components/account-recovery-form";
export const metadata: Metadata = {
  title: "Set up account",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export default function ActivateAccountPage() {
  return <AccountRecoveryForm mode="activate" />;
}
