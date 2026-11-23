import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";
export const metadata: Metadata = { title: "Sign in" };
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ passwordChanged?: string }>;
}) {
  const query = await searchParams;
  return <LoginForm passwordChanged={query.passwordChanged === "1"} />;
}
