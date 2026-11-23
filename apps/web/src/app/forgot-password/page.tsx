import type { Metadata } from "next";
import { AccountRecoveryForm } from "@/components/account-recovery-form";
export const metadata: Metadata = {
  title: "Forgot password",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export default function ForgotPasswordPage() {
  return <AccountRecoveryForm mode="forgot" />;
}
