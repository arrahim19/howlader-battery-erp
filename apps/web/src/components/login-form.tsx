"use client";
import Link from "@/components/workspace-link";
import { useState } from "react";
import { useRouter } from "@/lib/workspace-router";
import { z } from "zod";
import {
  ArrowRight,
  BatteryCharging,
  Boxes,
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  ShieldCheck,
  Wrench,
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
  deviceLogin = false,
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
    <main className="grid min-h-screen lg:grid-cols-[1fr_1.05fr]">
      <section className="login-grid relative hidden flex-col overflow-hidden bg-[#101c31] p-12 text-white lg:flex xl:p-16">
        <Link href="/login" className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl border border-emerald-600/50 bg-emerald-500/15 text-emerald-300">
            <BatteryCharging size={28} />
          </span>
          <span>
            <strong className="block text-xl tracking-tight">Howlader</strong>
            <small className="text-[10px] tracking-[.23em] text-slate-400">
              BATTERY ERP
            </small>
          </span>
        </Link>
        <div className="relative my-auto py-16">
          <span className="mb-7 inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-[10px] font-medium text-slate-300">
            <span className="size-1.5 rounded-full bg-emerald-400" />
            THE WORKSPACE FOR YOUR BUSINESS
          </span>
          <h1 className="max-w-lg text-[44px] leading-[1.17] font-semibold tracking-[-1.8px] xl:text-[52px]">
            Your shop.
            <br />
            Connected.
            <br />
            <span className="text-emerald-400">Under control.</span>
          </h1>
          <p className="mt-6 max-w-sm text-sm leading-7 text-slate-400">
            From the first purchase to the next replacement. One dependable
            workspace for every battery and every customer.
          </p>
          <div className="mt-10 space-y-5">
            {[
              {
                icon: Boxes,
                title: "Know your stock",
                text: "Product models, stock quantities, complete history.",
              },
              {
                icon: Wrench,
                title: "Keep every promise",
                text: "Warranty claims with a traceable journey.",
              },
              {
                icon: ShieldCheck,
                title: "Work with confidence",
                text: "Secure sessions and role-based access.",
              },
            ].map(({ icon: Icon, title, text }) => (
              <div key={title} className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-lg border border-slate-700/60 bg-slate-800/50 text-emerald-400">
                  <Icon size={17} strokeWidth={1.6} />
                </span>
                <div>
                  <p className="text-xs font-medium text-slate-200">{title}</p>
                  <p className="mt-1 text-[10px] text-slate-500">{text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between text-[10px] text-slate-500">
          <span>HOWLADER BATTERY HOUSE</span>
          <span>Built for everyday business.</span>
        </div>
        <div className="pointer-events-none absolute -right-48 bottom-20 size-96 rounded-full bg-emerald-400/5 blur-3xl" />
      </section>
      <section className="flex flex-col items-center justify-center bg-[#fbfcfd] px-6 py-12 sm:px-12">
        <div className="w-full max-w-[365px]">
          <div className="mb-10 flex items-center gap-2 text-emerald-600 lg:hidden">
            <BatteryCharging size={30} />
            <strong className="text-lg tracking-tight text-slate-800">
              Howlader Battery ERP
            </strong>
          </div>
          <span className="mb-6 inline-flex size-11 items-center justify-center rounded-xl border border-slate-200 bg-white text-emerald-600 shadow-xs">
            <LockKeyhole size={21} strokeWidth={1.6} />
          </span>
          <p className="text-[10px] font-bold tracking-[.18em] text-emerald-600">
            WELCOME TO YOUR WORKSPACE
          </p>
          <h2 className="mt-3 text-[30px] font-bold tracking-tight text-slate-900">
            Good to see you again.
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-500">
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
            <div className="mt-9 space-y-4">
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
            className="mt-9 space-y-5"
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
          <p
            hidden={Boolean(googleLogin)}
            className="mt-10 text-[10px] leading-relaxed text-slate-400"
          >
            {deviceLogin ? (
              "প্রথমবার internet চালু রেখে sign in করুন। দোকানের ডেটা নামানো শেষ হলে এই device-এ offline login ও কাজ করতে পারবেন।"
            ) : (
              <>
                First local setup: create the owner account with{" "}
                <code className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">
                  npm run db:admin
                </code>
                . Login instructions are in README.md.
              </>
            )}
          </p>
        </div>
      </section>
    </main>
  );
}
