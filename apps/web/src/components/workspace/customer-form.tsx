"use client";
import { useState, type FormEvent } from "react";
import { LoaderCircle, Plus } from "lucide-react";
import { Field } from "@/components/reference-ui";
import { Button } from "@/components/ui/button";
import { post, type CustomerRecord } from "@/lib/api";

export function CustomerForm({
  preview,
  onSaved,
  onCancel,
  customer,
  onBusyChange,
}: {
  preview: boolean;
  onSaved: (customer: CustomerRecord) => void;
  onCancel?: () => void;
  customer?: CustomerRecord;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (preview || saving || (customer && !customer.version)) return;
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    const name = text("name");
    const phone = text("phone");
    const address = text("address");
    if (!name || !/^[+0-9][0-9 ()-]{5,29}$/.test(phone)) {
      setError("Enter the customer's name and a valid mobile number.");
      return;
    }
    if (!address) {
      setError("Enter the customer's address.");
      return;
    }
    setError("");
    setSaving(true);
    onBusyChange?.(true);
    try {
      const saved = await post<CustomerRecord>(
        customer ? `/customers/${customer.id}` : "/customers",
        {
          name,
          phone,
          address,
          ...(customer ? { version: customer.version } : {}),
        },
      );
      onSaved(saved);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to save the customer.",
      );
    } finally {
      setSaving(false);
      onBusyChange?.(false);
    }
  }
  return (
    <form onSubmit={save} aria-busy={saving} className="grid gap-4">
      <fieldset disabled={saving} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <legend className="sr-only">Customer contact information</legend>
        <Field label="Customer Name" required>
          <input
            name="name"
            defaultValue={customer?.name ?? ""}
            aria-label="Customer name"
            autoComplete="name"
            required
            maxLength={160}
          />
        </Field>
        <Field label="Mobile Number" required>
          <input
            name="phone"
            defaultValue={customer?.phone ?? ""}
            aria-label="Customer mobile number"
            type="tel"
            autoComplete="tel"
            placeholder="01XXXXXXXXX"
            required
            maxLength={30}
          />
        </Field>
        <Field label="Address" required className="sm:col-span-2">
          <textarea
            name="address"
            defaultValue={customer?.address ?? ""}
            aria-label="Customer address"
            autoComplete="street-address"
            maxLength={500}
            required
          />
        </Field>
      </fieldset>
      {error ? (
        <p
          role="alert"
          className="rounded-lg bg-red-50 p-3 text-sm text-red-700"
        >
          {error}
        </p>
      ) : null}
      {preview ? (
        <p className="text-xs text-amber-700">Sign in to save customers.</p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-3">
        {onCancel ? (
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={onCancel}
          >
            Cancel
          </Button>
        ) : null}
        <Button
          type="submit"
          disabled={preview || saving || Boolean(customer && !customer.version)}
        >
          {saving ? (
            <LoaderCircle className="animate-spin" />
          ) : customer ? null : (
            <Plus />
          )}
          {saving ? "Saving..." : customer ? "Save changes" : "Save Customer"}
        </Button>
      </div>
    </form>
  );
}
