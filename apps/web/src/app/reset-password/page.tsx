import type { Metadata } from "next";
import { AccountRecoveryForm } from "@/components/account-recovery-form";
export const metadata: Metadata = {
  title: "Reset password",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export default function ResetPasswordPage() {
  return <AccountRecoveryForm mode="reset" />;
}
