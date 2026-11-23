"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "@/lib/workspace-router";
import { Dialog } from "radix-ui";
import { Pencil, X } from "lucide-react";
import { api, post, CURRENT_USER_CHANGED_EVENT } from "@/lib/api";
import { useSession } from "@/components/session-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type UserRow = {
  id: string;
  name: string;
  login: string;
  email?: string | null;
  version: number;
  active: boolean;
  roles: { role: { code: string; name: string } }[];
};
type Account = { email: string | null; mailConfigured: boolean };
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Unable to save changes.";

function PasswordForm() {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("New passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await post("/auth/change-password", {
        currentPassword: current,
        newPassword: password,
      });
      setCurrent("");
      setPassword("");
      setConfirm("");
      router.replace("/login?passwordChanged=1");
      router.refresh();
    } catch (error) {
      setError(message(error));
      setBusy(false);
    }
  }
  return (
    <form onSubmit={save} className="space-y-3 border-t border-slate-100 pt-5">
      <h3 className="text-sm font-semibold">Change password</h3>
      <p className="text-xs leading-relaxed text-slate-500">
        Use at least 6 characters. After changing your password, sign in again
        on your devices.
      </p>
      <fieldset disabled={busy} className="space-y-3">
        <label className="block space-y-1.5 text-xs text-slate-600">
          <span>Current password</span>
          <Input
            type="password"
            autoComplete="current-password"
            required
            maxLength={256}
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        <label className="block space-y-1.5 text-xs text-slate-600">
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
        <label className="block space-y-1.5 text-xs text-slate-600">
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
      </fieldset>
      {error ? (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy}>
        {busy ? "Changing password…" : "Change password"}
      </Button>
    </form>
  );
}

function EmailForm({ initialEmail }: { initialEmail: string }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api<Account>("/auth/account", { signal: controller.signal })
      .then(setAccount)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setError(message(error));
      });
    return () => controller.abort();
  }, []);
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setStatus("");
    setBusy(true);
    try {
      const result = await post<{ message: string }>(
        "/auth/email/request-verification",
        { email: email.trim().toLowerCase(), currentPassword: password },
      );
      setStatus(result.message);
      setPassword("");
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={send} className="space-y-3 border-t border-slate-100 pt-5">
      <h3 className="text-sm font-semibold">Email login & recovery</h3>
      <p className="text-xs leading-relaxed text-slate-500">
        Verify your Gmail address to sign in with it and receive password reset
        links. Your existing login will also work.
      </p>
      {account?.email ? (
        <p className="text-xs text-emerald-700">
          Verified email: {account.email}
        </p>
      ) : null}
      {account && !account.mailConfigured ? (
        <p
          role="status"
          className="rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800"
        >
          Email delivery needs to be enabled by the shop administrator before
          verification or password recovery can be used.
        </p>
      ) : null}
      <fieldset
        disabled={busy || !account?.mailConfigured}
        className="space-y-3"
      >
        <label className="block space-y-1.5 text-xs text-slate-600">
          <span>Email address</span>
          <Input
            type="email"
            autoComplete="email"
            required
            maxLength={120}
            placeholder="you@gmail.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="block space-y-1.5 text-xs text-slate-600">
          <span>Password to confirm email change</span>
          <Input
            type="password"
            autoComplete="current-password"
            required
            maxLength={256}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
      </fieldset>
      {error ? (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
      {status ? (
        <p role="status" className="text-xs leading-relaxed text-emerald-700">
          {status}
        </p>
      ) : null}
      <Button
        type="submit"
        variant="outline"
        disabled={
          busy ||
          !account?.mailConfigured ||
          email.trim().toLowerCase() === account.email
        }
      >
        {busy ? "Sending…" : "Send verification email"}
      </Button>
    </form>
  );
}

export function UserEditor({
  row,
  onSaved,
}: {
  row: UserRow;
  onSaved: (update: { id: string; name: string; version: number }) => void;
}) {
  const user = useSession();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(row.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const update = await post<{ id: string; name: string; version: number }>(
        `/users/${row.id}/profile`,
        { name: name.trim(), version: row.version },
      );
      setName(update.name);
      onSaved(update);
      setSaved(true);
      if (row.id === user?.id)
        window.dispatchEvent(new Event(CURRENT_USER_CHANGED_EVENT));
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          setOpen(next);
          if (next) {
            setName(row.name);
            setError("");
            setSaved(false);
          }
        }
      }}
    >
      <Dialog.Trigger asChild>
        <Button variant="outline" size="sm" aria-label={`Edit ${row.name}`}>
          <Pencil size={14} />
          Edit
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[88dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-xl sm:p-6">
          <Dialog.Title className="pr-8 text-lg font-semibold">
            Edit user
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-slate-500">
            Update account details for {row.login}.
          </Dialog.Description>
          <Dialog.Close
            disabled={busy}
            aria-label="Close user editor"
            className="absolute top-4 right-4 rounded p-1 text-slate-500"
          >
            <X size={18} />
          </Dialog.Close>
          <div className="mt-5 space-y-5">
            <form onSubmit={save} className="space-y-3">
              <label className="block space-y-1.5 text-xs text-slate-600">
                <span>Name</span>
                <Input
                  required
                  maxLength={120}
                  autoComplete="name"
                  value={name}
                  disabled={busy}
                  onChange={(e) => {
                    setName(e.target.value);
                    setSaved(false);
                  }}
                />
              </label>
              <p className="text-xs text-slate-500">Login: {row.login}</p>
              {error ? (
                <p role="alert" className="text-xs text-red-600">
                  {error}
                </p>
              ) : null}
              {saved ? (
                <p role="status" className="text-xs text-emerald-700">
                  Name updated.
                </p>
              ) : null}
              <Button
                type="submit"
                disabled={busy || !name.trim() || name.trim() === row.name}
              >
                {busy ? "Saving…" : "Save name"}
              </Button>
            </form>
            {row.id === user?.id ? (
              <>
                <EmailForm initialEmail={row.email ?? ""} />
                <PasswordForm />
              </>
            ) : (
              <p className="border-t border-slate-100 pt-4 text-xs leading-relaxed text-slate-500">
                This user can change their own password or use Forgot password
                with their verified email.
              </p>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
