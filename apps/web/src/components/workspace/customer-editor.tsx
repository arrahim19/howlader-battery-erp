"use client";

import { useEffect, useState } from "react";
import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import { api, type CustomerRecord } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { CustomerForm } from "./customer-form";

export function CustomerEditor({
  customerId,
  onClose,
  onSaved,
  returnFocus,
}: {
  customerId: string;
  onClose: () => void;
  onSaved: (customer: CustomerRecord) => void;
  returnFocus: () => void;
}) {
  const [customer, setCustomer] = useState<CustomerRecord | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api<CustomerRecord>(`/customers/${customerId}`, {
      signal: controller.signal,
    })
      .then((customer) => {
        if (!controller.signal.aborted) setCustomer(customer);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error ? error.message : "Unable to load customer.",
          );
      });
    return () => controller.abort();
  }, [customerId, revision]);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-100 bg-slate-950/40" />
        <Dialog.Content
          className="feature-dialog z-110! max-h-[calc(100dvh-32px)] overflow-y-auto"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus();
          }}
        >
          <Dialog.Title className="text-xl font-bold">
            Edit Customer
          </Dialog.Title>
          <Dialog.Description className="mt-2 mb-5 text-xs text-slate-500">
            Update the customer's name, mobile number and address.
          </Dialog.Description>
          {customer ? (
            <CustomerForm
              preview={false}
              customer={customer}
              onBusyChange={setBusy}
              onCancel={onClose}
              onSaved={onSaved}
            />
          ) : error ? (
            <div className="space-y-3">
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
              <Button
                variant="outline"
                onClick={() => {
                  setError("");
                  setRevision((n) => n + 1);
                }}
              >
                Retry
              </Button>
            </div>
          ) : (
            <p role="status" className="text-sm text-slate-500">
              Loading customer…
            </p>
          )}
          <Dialog.Close
            disabled={busy}
            aria-label="Close customer editor"
            className="absolute top-4 right-4"
          >
            <X size={18} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
