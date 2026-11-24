"use client";
import { BrandLogo } from "@/components/brand-logo";
import Link from "@/components/workspace-link";
import { useState } from "react";
import { useRouter } from "@/lib/workspace-router";
import { z } from "zod";
import {
  ArrowRight,
  Eye,
  EyeOff,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { post } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const schema = z.object({
  login: z.string().trim().min(1, "Enter your login.").max(120),
  password: z.string().min(1, "Enter your password.").max(256),
});
export function LoginForm({
  passwordChanged = false,
  googleLogin,
}: {
  passwordChanged?: boolean;
  deviceLogin?: boolean;
  googleLogin?: {
    busy: boolean;
    pending: boolean;
    onClick: () => void;
    error?: string;
    saved?: boolean;
    onSaved?: () => void;
  };
}) {
  const router = useRouter();
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setFields({});
    const form = new FormData(event.currentTarget);
    const result = schema.safeParse({
      login: form.get("login"),
      password: form.get("password"),
    });
    if (!result.success) {
      setFields(
        Object.fromEntries(
          result.error.issues.map((issue) => [
            String(issue.path[0]),
            issue.message,
          ]),
        ),
      );
      return;
    }
    setLoading(true);
    try {
      await post("/auth/login", result.data);
      router.replace("/dashboard");
      router.refresh();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Sign in failed. Check that the backend and database are running.",
      );
      setLoading(false);
    }
  }
  return (
    <main className="grid min-h-screen">
      <section className="flex flex-col items-center justify-center bg-[#fbfcfd] px-6 py-8 sm:px-12 sm:py-12">
        <div className="w-full max-w-[365px]">
          <div className="mb-5 flex justify-center">
            <BrandLogo size={96} />
          </div>
          <h2 className="text-center text-[26px] leading-tight font-bold tracking-tight text-slate-900 sm:text-[30px]">
            Good to see you again.
          </h2>
          <p className="mt-1.5 text-center text-sm leading-normal text-slate-500">
            Sign in to manage Howlader Battery House.
          </p>
          {passwordChanged ? (
            <p
              role="status"
              className="mt-5 rounded-lg bg-emerald-50 p-3 text-xs text-emerald-800"
            >
              Password changed. Sign in with your new password.
            </p>
          ) : null}
          {googleLogin ? (
            <div className="mt-6 space-y-4">
              <Button
                type="button"
                className="h-11 w-full"
                disabled={googleLogin.busy}
                onClick={googleLogin.onClick}
              >
                {googleLogin.busy ? (
                  <LoaderCircle className="animate-spin" />
                ) : null}
                Continue with Google
                <ArrowRight className="ml-auto" />
              </Button>
              {googleLogin.saved && (
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 w-full"
                  onClick={googleLogin.onSaved}
                >
                  Open saved shop
                </Button>
              )}
              {googleLogin.error && (
                <p
                  role="alert"
                  className="rounded-lg bg-red-50 p-3 text-sm text-red-700"
                >
                  {googleLogin.error}
                </p>
              )}
              <p
                role="status"
                className="text-sm leading-relaxed text-slate-500"
              >
                {googleLogin.pending
                  ? "Google sign-in শেষ করে এই tab-এ ফিরে আসুন।"
                  : "Sign in with your approved Gmail to open your shop and restore its Drive backup."}
              </p>
            </div>
          ) : null}
          <form
            hidden={Boolean(googleLogin)}
            onSubmit={submit}
            className="mt-6 space-y-4"
            noValidate
          >
            <div>
              <label
                htmlFor="login"
                className="mb-2 block text-xs font-semibold text-slate-700"
              >
                Email or login
              </label>
              <Input
                id="login"
                name="login"
                autoComplete="username"
                autoCapitalize="none"
                placeholder="Enter your email or login"
                disabled={loading}
                aria-invalid={Boolean(fields.login)}
                aria-describedby={fields.login ? "login-error" : undefined}
              />
              {fields.login ? (
                <p id="login-error" className="mt-1.5 text-xs text-red-600">
                  {fields.login}
                </p>
              ) : null}
            </div>
            <div>
              <label
                htmlFor="password"
                className="mb-2 block text-xs font-semibold text-slate-700"
              >
                Password
              </label>
              <div className="relative">
                <Input
                  id="password"
                  name="password"
                  type={show ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  className="pr-11"
                  disabled={loading}
                  aria-invalid={Boolean(fields.password)}
                  aria-describedby={
                    fields.password ? "password-error" : undefined
                  }
                />
                <button
                  type="button"
                  onClick={() => setShow((value) => !value)}
                  className="absolute inset-y-0 right-0 px-3 text-slate-400"
                  aria-label={show ? "Hide password" : "Show password"}
                >
                  {show ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {fields.password ? (
                <p id="password-error" className="mt-1.5 text-xs text-red-600">
                  {fields.password}
                </p>
              ) : null}
            </div>
            {error ? (
              <div
                role="alert"
                className="rounded-lg border border-red-100 bg-red-50 p-3 text-xs leading-relaxed text-red-700"
              >
                {error}
              </div>
            ) : null}
            <Button type="submit" className="h-11 w-full" disabled={loading}>
              {loading ? <LoaderCircle className="animate-spin" /> : null}
              {loading ? "Signing in..." : "Sign in to workspace"}
              {!loading ? <ArrowRight className="ml-auto" /> : null}
            </Button>
          </form>
          <Link
            href="/forgot-password"
            hidden={Boolean(googleLogin)}
            className="mt-5 block text-center text-sm font-medium text-emerald-700 hover:underline"
          >
            Forgot password?
          </Link>
          <div className="mt-6 flex items-center justify-center gap-1.5 text-[10px] text-slate-400">
            <ShieldCheck size={13} />
            Secure access for authorized shop staff
          </div>
        </div>
      </section>
    </main>
  );
}
