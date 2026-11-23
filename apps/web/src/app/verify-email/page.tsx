import type { Metadata } from "next";
import { AccountRecoveryForm } from "@/components/account-recovery-form";
export const metadata: Metadata = {
  title: "Verify email",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export default function VerifyEmailPage() {
  return <AccountRecoveryForm mode="verify" />;
}
