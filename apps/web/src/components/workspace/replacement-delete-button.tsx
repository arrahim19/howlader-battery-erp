"use client";
import { useState } from "react";
import { AlertDialog } from "radix-ui";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/components/session-provider";
import { api, csrf, type ReplacementCase } from "@/lib/api";
import { notifyDashboardUpdate } from "@/lib/use-dashboard";

export function ReplacementDeleteButton({
  item,
  preview,
  onDeleted,
}: {
  item: ReplacementCase;
  preview: boolean;
  onDeleted: () => void;
}) {
  const user = useSession();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  if (
    !preview &&
    (!user?.permissions.includes("transactions.reverse") ||
      !user.permissions.includes("replacements.resolve"))
  )
    return null;
  async function remove() {
    if (saving || preview) return;
    setSaving(true);
    setError("");
    try {
      await api(`/replacements/${item.id}`, {
        method: "DELETE",
        headers: { "X-CSRF-Token": await csrf() },
        body: JSON.stringify({ confirmed: true, version: item.version }),
      });
      setOpen(false);
      onDeleted();
      notifyDashboardUpdate();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Delete failed. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!saving) {
          setOpen(next);
          setError("");
        }
      }}
    >
      <AlertDialog.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={preview}
          aria-label={`Delete replacement ${item.number}`}
          className="text-red-600 hover:bg-red-50 hover:text-red-700"
        >
          <Trash2 />
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-60 bg-slate-950/40" />
        <AlertDialog.Content
          className="feature-dialog"
          onEscapeKeyDown={(event) => {
            if (saving) event.preventDefault();
          }}
        >
          <AlertDialog.Title className="text-lg font-bold">
            Delete Replacement
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-3 text-sm text-slate-600">
            {item.source === "BEFORE_SALE" || !item.invoice
              ? "এই Replacement মুছলে ব্যাটারি আগের stock অবস্থায় ফিরে যাবে।"
              : "এই Replacement মুছলে ব্যাটারি আগের customer অবস্থায় ফিরে যাবে; দোকানের বিক্রিযোগ্য stock-এ যোগ হবে না।"}{" "}
            আগের Purchase amount ও Supplier balance বদলাবে না।
          </AlertDialog.Description>
          {error ? (
            <p role="alert" className="mt-3 text-sm text-red-700">
              {error}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-3">
            <AlertDialog.Cancel asChild>
              <Button type="button" variant="outline" disabled={saving}>
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <Button
              type="button"
              disabled={saving}
              onClick={() => void remove()}
              className="bg-red-600 hover:bg-red-700"
            >
              {saving ? "Deleting…" : "Delete Replacement"}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
