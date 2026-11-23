import { useEffect, useState } from "react";
import { Panel } from "../../../web/src/components/reference-ui";
import { Button } from "../../../web/src/components/ui/button";
import { api, post } from "./api";
import type { Command, SyncStatus } from "../lib/offline/engine";

export function LocalData({
  status,
  origin,
}: {
  status: SyncStatus;
  origin: string;
}) {
  const [commands, setCommands] = useState<Command[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    api<Command[]>("/__local/commands")
      .then((items) => {
        if (active) setCommands(items);
      })
      .catch((failure) => {
        if (active) setError(String(failure));
      });
    return () => {
      active = false;
    };
  }, [status.pending, status.blocked, status.lastSync, revision]);
  async function action(route: string, id?: string) {
    setBusy(true);
    setError("");
    try {
      await post(route, { id });
      setRevision((value) => value + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Sync failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 pb-4">
      <Panel title="Sync & local data">
        <div className="erp-form-body space-y-3">
          <p>
            {status.offline ? "Offline" : "Connected"} · {status.pending}{" "}
            pending · {status.blocked} need review
          </p>
          <p className="break-all text-xs text-slate-500">Server: {origin}</p>
          <p className="text-xs text-slate-500">
            Transactions, stock and balances are saved on this device. Offline
            references begin with OFF-. Online sync uploads each operation once
            and replaces offline references with the server invoice numbers.
          </p>
          {status.lastSync ? (
            <p className="text-xs text-slate-500">
              Last synced:{" "}
              {new Date(status.lastSync).toLocaleString("en-GB", {
                timeZone: "Asia/Dhaka",
              })}
            </p>
          ) : null}
          {error || status.error ? (
            <p role="alert" className="text-sm text-red-700">
              {error || status.error}
            </p>
          ) : null}
          <Button
            disabled={busy || status.syncing}
            onClick={() => void action("/__local/sync")}
          >
            {busy || status.syncing ? "Syncing…" : "Sync now"}
          </Button>
        </div>
      </Panel>
      {commands === null ? (
        <Panel title="Saved transactions">
          <div className="erp-form-body" role="status">
            {error
              ? "Unable to read saved transactions. Try Sync now again."
              : "Loading saved transactions…"}
          </div>
        </Panel>
      ) : !commands.length && !status.pending && !status.blocked ? (
        <Panel title="Saved transactions">
          <div className="erp-form-body">
            All saved transactions have reached the server.
          </div>
        </Panel>
      ) : (
        commands.map((command) => {
          const body = command.body as {
            amount?: string;
            saleDate?: string;
            purchaseDate?: string;
            items?: unknown[];
          };
          return (
            <Panel
              key={command.id}
              title={
                command.state === "blocked"
                  ? "Needs review"
                  : "Waiting for sync"
              }
            >
              <div className="erp-form-body space-y-3">
                <p>
                  {command.route.startsWith("/sales/")
                    ? "Sale"
                    : command.route.startsWith("/purchases/")
                      ? "Purchase"
                      : command.route === "/expenses"
                        ? "Expense"
                        : "Customer collection"}
                  {body.items
                    ? ` · ${body.items.length} product lines`
                    : body.amount
                      ? ` · ৳${body.amount}`
                      : ""}
                </p>
                <p className="text-xs text-slate-500">
                  {new Date(command.createdAt).toLocaleString("en-GB", {
                    timeZone: "Asia/Dhaka",
                  })}
                </p>
                {command.error ? (
                  <p role="alert" className="text-sm text-red-700">
                    {command.error}
                  </p>
                ) : null}
                {command.state === "blocked" ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={busy}
                      onClick={() => void action("/__local/retry", command.id)}
                    >
                      Retry this transaction
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            "Remove this server-rejected local entry?",
                          )
                        )
                          void action("/__local/discard", command.id);
                      }}
                    >
                      Remove rejected entry
                    </Button>
                  </div>
                ) : null}
              </div>
            </Panel>
          );
        })
      )}
    </div>
  );
}
