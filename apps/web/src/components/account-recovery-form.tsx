"use client";

import Link from "@/components/workspace-link";
import { useState, type FormEvent } from "react";
import { KeyRound, MailCheck } from "lucide-react";
import { post } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function AccountRecoveryForm({
  mode,
}: {
  mode: "forgot" | "reset" | "verify" | "activate";
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const title =
    mode === "forgot"
      ? "Forgot password"
      : mode === "activate"
        ? "Set up your shop account"
        : mode === "reset"
          ? "Choose a new password"
          : "Verify your email";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setStatus("");
    if ((mode === "reset" || mode === "activate") && password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    const token =
      new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
    if (mode !== "forgot" && !/^[a-f0-9]{64}$/.test(token)) {
      setError(
        "This link is invalid. Open the complete link from your email or request a new one.",
      );
      return;
    }
    setBusy(true);
    try {
      const result = await post<{ message: string }>(
        mode === "forgot"
          ? "/auth/forgot-password"
          : mode === "activate"
            ? "/auth/activate-account"
            : mode === "reset"
              ? "/auth/reset-password"
              : "/auth/email/verify",
        mode === "forgot"
          ? { email: email.trim().toLowerCase() }
          : mode === "reset" || mode === "activate"
            ? { token, newPassword: password }
            : { token },
      );
      setStatus(result.message);
      setPassword("");
      setConfirm("");
      if (mode !== "forgot")
        window.history.replaceState(null, "", window.location.pathname);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to complete this request.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-5 py-10">
      <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <span className="mb-5 inline-flex rounded-xl bg-emerald-50 p-3 text-emerald-600">
          {mode === "verify" ? <MailCheck /> : <KeyRound />}
        </span>
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-500">
          {mode === "forgot"
            ? "Enter the verified email linked to your account. We will send a link to reset your password."
            : mode === "activate"
              ? "Choose a password with at least 6 characters to activate your account and verify this email. Your shop has its own separate accounts and stock."
              : mode === "reset"
                ? "Use at least 6 characters. After resetting, sign in again on your devices."
                : "Confirm this email to use it for login and password recovery. You will then sign in again with your existing password."}
        </p>
        {status ? (
          <div className="mt-6 space-y-4">
            <p
              role="status"
              className="rounded-lg bg-emerald-50 p-3 text-sm leading-relaxed text-emerald-800"
            >
              {status}
            </p>
            <Button asChild className="w-full">
              <Link href="/login">Back to sign in</Link>
            </Button>
            {mode === "forgot" ? (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setStatus("")}
              >
                Send another link
              </Button>
            ) : null}
          </div>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-4">
            <fieldset disabled={busy} className="space-y-4">
              {mode === "forgot" ? (
                <label className="block space-y-2 text-xs text-slate-600">
                  <span>Email address</span>
                  <Input
                    type="email"
                    autoComplete="email"
                    required
                    maxLength={120}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@gmail.com"
                  />
                </label>
              ) : null}
              {mode === "reset" || mode === "activate" ? (
                <>
                  <label className="block space-y-2 text-xs text-slate-600">
                    <span>New password</span>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={6}
                      maxLength={256}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </label>
                  <label className="block space-y-2 text-xs text-slate-600">
                    <span>Confirm new password</span>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={6}
                      maxLength={256}
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                    />
                  </label>
                </>
              ) : null}
            </fieldset>
            {error ? (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy
                ? "Please wait…"
                : mode === "forgot"
                  ? "Send reset link"
                  : mode === "activate"
                    ? "Activate account"
                    : mode === "reset"
                      ? "Reset password"
                      : "Verify email"}
            </Button>
            <Link
              href="/login"
              className="block text-center text-sm text-slate-500 hover:text-emerald-700"
            >
              Back to sign in
            </Link>
            {mode === "reset" || mode === "activate" ? (
              <Link
                href="/forgot-password"
                className="block text-center text-xs text-emerald-700"
              >
                Request a new reset link
              </Link>
            ) : null}
          </form>
        )}
      </section>
    </main>
  );
}
