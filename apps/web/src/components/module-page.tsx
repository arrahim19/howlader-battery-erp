"use client";
import Link from "@/components/workspace-link";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Construction,
  FileText,
  LockKeyhole,
  Package,
  ShieldCheck,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useSession } from "@/components/session-provider";
import { PageHeader } from "@/components/page-header";
import { FilterBar } from "@/components/filter-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/empty-state";
import { modules } from "@/lib/modules";
import {
  ReferenceWorkspace,
  referenceModules,
} from "@/components/reference-workspace";

import { UserEditor, type UserRow } from "@/components/user-editor";
import {
  ShopProfileForm,
  type ShopSettings,
} from "@/components/shop-profile-form";
export function ModulePage({
  module,
  preview = false,
  subpage,
  initialCustomerId,
}: {
  module: string;
  preview?: boolean;
  subpage?: string;
  initialCustomerId?: string;
}) {
  const config = modules[module];
  const user = useSession();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(!preview);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [shop, setShop] = useState<ShopSettings | null>(null);
  useEffect(() => {
    if (preview || !user) return;
    const controller = new AbortController();
    api<{ status: string }>("/modules/" + module, { signal: controller.signal })
      .then(async () => {
        if (module === "users")
          setUsers(
            await api<UserRow[]>("/users", { signal: controller.signal }),
          );
        if (module === "settings")
          setShop(
            await api<ShopSettings | null>("/settings/shop", {
              signal: controller.signal,
            }),
          );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setDenied(error instanceof ApiError && error.status === 403);
        setError(
          error instanceof Error ? error.message : "Workspace unavailable.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [module, preview, user]);
  if (!config) return null;
  if (referenceModules.includes(module))
    return (
      <ReferenceWorkspace
        moduleId={module}
        preview={preview}
        view={subpage}
        loading={loading}
        error={error}
        denied={denied}
        initialCustomerId={initialCustomerId}
      />
    );
  const filtered = users.filter(
    (row) =>
      [row.name, row.login]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (filter === "all" || row.active === (filter === "active")),
  );
  return (
    <>
      <PageHeader
        eyebrow="WORKSPACE"
        title={config.title}
        description={config.description}
        actions={
          <Badge variant={denied ? "destructive" : "secondary"}>
            {denied
              ? "Restricted"
              : module === "users"
                ? "Accounts"
                : config.phase === 2
                  ? "Foundation"
                  : `Phase ${config.phase}`}
          </Badge>
        }
      />
      {error ? (
        <Card className="mb-5 border-amber-200 bg-amber-50">
          <CardContent className="pt-5">
            <div role="alert" className="flex gap-3 text-sm text-amber-800">
              <LockKeyhole className="size-5 shrink-0" />
              <span>{error}</span>
            </div>
          </CardContent>
        </Card>
      ) : null}
      {subpage ? (
        <div className="mb-5">
          <Button asChild variant="outline" size="sm">
            <Link href={preview ? "/preview?module=" + module : "/" + module}>
              <ArrowLeft />
              Back to {config.title.toLowerCase()}
            </Link>
          </Button>
        </div>
      ) : null}
      <Card className="mb-5 border-blue-100 bg-blue-50/50">
        <CardContent className="flex items-start gap-3 pt-5">
          <span className="rounded-lg bg-white p-2 text-blue-500">
            <Construction size={19} />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-slate-800">
              {module === "users"
                ? "Manage user accounts"
                : module === "settings"
                  ? "Manage your shop profile"
                  : "This workspace is ready for its next phase"}
            </h2>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-500">
              {module === "users"
                ? "Edit user names, change your password, and verify an email for login and password recovery."
                : module === "settings"
                  ? "Update your shop name, address, and phone number. Saved details also appear in the sidebar."
                  : `Navigation, layout, and backend access checks are in place. ${config.title} workflows will be implemented in Phase ${config.phase}; no transaction can be posted from this page yet.`}
            </p>
          </div>
        </CardContent>
      </Card>
      {module === "settings" ? (
        <div className="grid gap-5 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Shop profile</CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p role="status" className="text-sm text-slate-500">
                  Loading shop profile…
                </p>
              ) : (
                <ShopProfileForm
                  shop={
                    preview
                      ? {
                          value: { name: "Hawlader Battery House" },
                          version: 0,
                        }
                      : shop
                  }
                  disabled={denied || !!error}
                  preview={preview}
                  onSaved={setShop}
                />
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Access and session security</CardTitle>
              <ShieldCheck size={17} className="text-emerald-600" />
            </CardHeader>
            <CardContent className="space-y-3 text-xs leading-relaxed text-slate-500">
              <p>
                Passwords are hashed with Argon2id. Session tokens are stored as
                digests in PostgreSQL.
              </p>
              <p>
                Every protected API request checks current permissions. Unsafe
                requests require an allowed Origin and a CSRF token.
              </p>
              <p className="rounded-lg bg-slate-50 p-3">
                Signed in as: {preview ? "Preview visitor" : user?.login}
              </p>
            </CardContent>
          </Card>
        </div>
      ) : (
        <Card className="overflow-hidden">
          <CardHeader>
            <div className="flex items-center gap-2">
              <CardTitle>
                {module === "users" ? "Configured users" : "All records"}
              </CardTitle>
              <Badge variant="secondary">
                {module === "users" && !preview
                  ? filtered.length
                  : "Not active"}
              </Badge>
            </div>
            <FileText size={16} className="text-slate-400" />
          </CardHeader>
          <FilterBar
            search={search}
            onSearch={setSearch}
            filter={filter}
            onFilter={setFilter}
          />
          <Table aria-busy={loading}>
            <TableHeader>
              <TableRow>
                {config.columns.map((column) => (
                  <TableHead key={column}>{column}</TableHead>
                ))}
                {module === "users" ? <TableHead>Actions</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell
                    colSpan={
                      config.columns.length + (module === "users" ? 1 : 0)
                    }
                  >
                    <span role="status">Loading records…</span>
                  </TableCell>
                </TableRow>
              ) : module === "users" && filtered.length && !denied ? (
                filtered.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-semibold">{row.name}</TableCell>
                    <TableCell>
                      {row.login}
                      {row.email ? (
                        <span className="mt-1 block text-xs text-slate-500">
                          {row.email}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {row.roles.map((entry) => entry.role.name).join(", ")}
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.active ? "default" : "secondary"}>
                        {row.active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <UserEditor
                        row={row}
                        onSaved={(update) =>
                          setUsers((rows) =>
                            rows.map((entry) =>
                              entry.id === update.id
                                ? { ...entry, ...update }
                                : entry,
                            ),
                          )
                        }
                      />
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    className="p-0"
                    colSpan={
                      config.columns.length + (module === "users" ? 1 : 0)
                    }
                  >
                    <EmptyState
                      icon={denied ? LockKeyhole : Package}
                      title={
                        denied
                          ? "Access is restricted"
                          : search
                            ? "No matching records"
                            : "No records to display"
                      }
                      description={
                        preview
                          ? "This is a layout preview. Sign in to access your real workspace."
                          : module === "users"
                            ? "No configured users match these filters."
                            : `Business operations will be connected in Phase ${config.phase}. This table does not contain sample records.`
                      }
                    />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-5 py-4 text-[11px] text-slate-400">
            <span>
              {module === "users" && !preview
                ? `${filtered.length} configured users`
                : "Business records not connected in this phase"}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled>
                Previous
              </Button>
              <Button size="sm" variant="outline" disabled>
                Next
              </Button>
            </div>
          </div>
        </Card>
      )}
    </>
  );
}
