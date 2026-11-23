"use client";
import Link from "@/components/workspace-link";
import { usePathname, useRouter } from "@/lib/workspace-router";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Dialog, DropdownMenu } from "radix-ui";
import {
  ArrowLeftRight,
  BatteryCharging,
  Bell,
  Boxes,
  CalendarDays,
  ChevronDown,
  ClipboardList,
  CreditCard,
  House,
  LogOut,
  Menu,
  Phone,
  Settings2,
  Trash2,
  ShoppingBag,
  ShoppingCart,
  Store,
  Truck,
  Users,
  UsersRound,
  X,
} from "lucide-react";
import { api, post, RESOURCE_CHANGED_EVENT } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useSession } from "@/components/session-provider";
import { Button } from "@/components/ui/button";
import { workspaceHref } from "@/components/reference-ui";
import { useBusinessDate } from "@/lib/use-business-date";

export const navigation = [
  {
    label: "Dashboard",
    href: "/dashboard",
    icon: House,
    permission: "dashboard.read",
  },
  {
    label: "Sales",
    href: "/sales",
    icon: ShoppingCart,
    permission: "sales.manage",
  },
  {
    label: "Purchase",
    href: "/purchases",
    icon: ShoppingBag,
    permission: "purchases.manage",
  },
  {
    label: "Inventory / Stock",
    href: "/inventory",
    icon: Boxes,
    permission: "inventory.read",
  },
  {
    label: "Replacement",
    href: "/replacements",
    icon: ArrowLeftRight,
    permission: "replacements.intake.customer",
  },
  {
    label: "Customers",
    href: "/customers",
    icon: Users,
    permission: "parties.customers",
  },
  {
    label: "Suppliers",
    href: "/suppliers",
    icon: Truck,
    permission: "parties.suppliers",
  },
  {
    label: "Accounts & Expenses",
    href: "/accounts",
    icon: CreditCard,
    permission: "finance.read",
  },
  {
    label: "Users & Permissions",
    href: "/users",
    icon: UsersRound,
    permission: "access.manage",
  },
  {
    label: "Recycle Bin",
    href: "/recycle-bin",
    icon: Trash2,
    permission: "parties.suppliers",
  },
  {
    label: "Settings",
    href: "/settings",
    icon: Settings2,
    permission: "settings.manage",
  },
];
const quickAccessLabels: Record<string, string> = {
  "/inventory": "Inventory",
  "/purchases": "Purchase",
  "/sales": "Sales",
  "/customers": "Customer",
  "/dashboard": "Dashboard",
};
function BrandMark() {
  return (
    <svg viewBox="0 0 56 48" aria-hidden="true">
      <path
        d="M13 9V4h7v5m16 0V4h7v5M9 11h39a3 3 0 0 1 3 3v26a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V14a3 3 0 0 1 3-3Zm-3 9h45"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.7"
        strokeLinejoin="round"
      />
      <path d="m30 23-6 9h6l-2 8 10-12h-7l2-5Z" fill="currentColor" />
      <path
        d="M13 27h5m-5 8h5m25-8h3m-3 8h3"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
export function AppShell({
  children,
  preview = false,
  previewModule = "dashboard",
  deviceMenu,
  deviceStatus,
  headerStatus,
}: {
  children: ReactNode;
  preview?: boolean;
  previewModule?: string;
  previewView?: string;
  deviceMenu?: ReactNode;
  deviceStatus?: ReactNode;
  headerStatus?: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const user = useSession();
  const [shopProfile, setShopProfile] = useState<{
    name?: string;
    address?: string;
    phone?: string;
  } | null>(null);
  useEffect(() => {
    if (preview || !user) return;
    let controller: AbortController | undefined;
    function refresh() {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      api<{ name?: string; address?: string; phone?: string }>(
        "/shop-profile",
        { signal },
      )
        .then((profile) => {
          if (!signal.aborted) setShopProfile(profile);
        })
        .catch(() => {
          /* Keep the last shop identity when a refresh is unavailable. */
        });
    }
    function onStorage(event: StorageEvent) {
      if (event.key === RESOURCE_CHANGED_EVENT) refresh();
    }
    refresh();
    window.addEventListener(RESOURCE_CHANGED_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      controller?.abort();
      window.removeEventListener(RESOURCE_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, [preview, user]);
  const shopName = shopProfile?.name || "Howlader Battery";
  const current = preview ? previewModule : pathname.split("/")[1];
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (window.matchMedia("(max-width: 1023px)").matches) {
      if (contentRef.current) contentRef.current.scrollTop = 0;
      window.scrollTo(0, 0);
    }
  }, [pathname, previewModule]);
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const currentLabel =
    current === "replacements"
      ? "Replacement / Warranty"
      : (navigation.find((item) => item.href === "/" + current)?.label ??
        "Workspace");
  const visible = navigation.filter(
    (item) =>
      preview ||
      !user ||
      user?.permissions.includes(item.permission) ||
      (item.href === "/recycle-bin" &&
        user?.permissions.includes("transactions.reverse") &&
        ["sales.manage", "purchases.manage"].some((p) =>
          user?.permissions.includes(p),
        )),
  );
  const displayName = preview ? "Admin" : (user?.name ?? "Account");
  const quickAccess = Object.keys(quickAccessLabels).flatMap((href) =>
    visible.filter((item) => item.href === href),
  );
  const initials = preview
    ? "AD"
    : displayName
        .split(" ")
        .map((word) => word[0])
        .slice(0, 2)
        .join("");
  const businessDay = useBusinessDate();
  const date = businessDay
    ? new Intl.DateTimeFormat("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Dhaka",
      }).format(new Date(businessDay + "T12:00:00+06:00"))
    : "—";
  async function logout() {
    setLoggingOut(true);
    setLogoutError("");
    try {
      await post("/auth/logout", {});
      router.replace("/login");
      router.refresh();
    } catch (error) {
      setLogoutError(
        error instanceof Error ? error.message : "Sign out failed.",
      );
      setLoggingOut(false);
    }
  }
  const sidebar = (
    <>
      <Link
        href={workspaceHref("dashboard", "", preview)}
        className="brand"
        aria-label={`${shopName} dashboard`}
        onClick={() => setOpen(false)}
      >
        <span className="brand-icon">
          <BrandMark />
        </span>
        <span>
          <strong>{shopName}</strong>
          {user?.shop?.branchName ? (
            <span className="mt-1 block text-[10px] font-medium text-slate-300">
              {user.shop.branchName}
            </span>
          ) : null}
        </span>
      </Link>
      <nav
        aria-label="Main navigation"
        className="sidebar-nav"
        inert={!preview && !user}
      >
        {visible.map((item) => {
          const key = item.href.slice(1);
          const active = key === current;
          return (
            <div key={item.href} className="nav-row">
              <Link
                href={workspaceHref(key, "", preview)}
                prefetch={true}
                title={collapsed ? item.label : undefined}
                onClick={() => setOpen(false)}
                className={cn("nav-item", active && "active")}
                aria-current={active ? "page" : undefined}
              >
                <item.icon size={20} strokeWidth={1.7} />
                <span>{item.label}</span>
              </Link>
            </div>
          );
        })}
      </nav>
      <div className="sidebar-bottom">
        <div className="shop-card">
          <Store size={28} strokeWidth={1.5} />
          <div>
            <strong>{shopProfile?.name || "হাওলাদার ব্যাটারী হাউজ"}</strong>
            <p>{shopProfile?.address || "ব্যাটারি ও অটো পার্টস ম্যানেজমেন্ট"}</p>
            <span>
              <Phone size={12} />
              {shopProfile?.phone || "যোগাযোগের তথ্য যুক্ত হয়নি"}
            </span>
          </div>
        </div>
      </div>
    </>
  );
  return (
    <div
      className={cn(
        "app-shell",
        quickAccess.length > 0 && "has-quick-access",
        current === "dashboard" && "dashboard-shell",
        current === "purchases" && "purchase-shell",
        current === "accounts" && "accounts-shell",
        current === "sales" && "sales-shell",
        ["inventory", "products"].includes(current) && "inventory-shell",
        collapsed && "sidebar-collapsed",
      )}
    >
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <aside className="desktop-sidebar">{sidebar}</aside>
      <div className="app-body">
        <header className="top-header">
          <div className="header-heading">
            <Button
              variant="ghost"
              size="icon"
              className="desktop-menu-button"
              aria-label={
                collapsed ? "Expand navigation" : "Collapse navigation"
              }
              onClick={() => setCollapsed(!collapsed)}
            >
              <Menu />
            </Button>
            <Dialog.Root open={open} onOpenChange={setOpen}>
              <Dialog.Trigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="mobile-menu-button"
                  aria-label="Open navigation"
                >
                  <Menu />
                </Button>
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/50" />
                <Dialog.Content className="mobile-sidebar">
                  <Dialog.Title className="sr-only">
                    Main navigation
                  </Dialog.Title>
                  <Dialog.Description className="sr-only">
                    Navigate between ERP modules.
                  </Dialog.Description>
                  <Dialog.Close
                    className="absolute top-3 right-2 z-10 rounded p-2 text-slate-400"
                    aria-label="Close navigation"
                  >
                    <X size={18} />
                  </Dialog.Close>
                  {sidebar}
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
            <h1>{currentLabel}</h1>
            {headerStatus}
          </div>
          <div className="header-controls">
            <span className="header-date">
              <CalendarDays size={17} />
              {date}
            </span>
            <Dialog.Root>
              <Dialog.Trigger asChild>
                <button
                  className="notification-button"
                  aria-label="Notifications"
                >
                  <Bell size={21} strokeWidth={1.7} />
                </button>
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/30" />
                <Dialog.Content className="feature-dialog">
                  <Dialog.Title className="text-xl font-bold">
                    নোটিফিকেশন
                  </Dialog.Title>
                  <Dialog.Description className="mt-3 text-sm text-slate-500">
                    এই মুহূর্তে নতুন কোনো নোটিফিকেশন নেই।
                  </Dialog.Description>
                  <Dialog.Close
                    className="absolute top-4 right-4"
                    aria-label="Close notifications"
                  >
                    <X size={18} />
                  </Dialog.Close>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                disabled={!preview && !user}
                className="account-trigger"
                aria-label="Account menu"
              >
                <span className="header-avatar">{initials}</span>
                <span className="account-name">
                  <strong>{displayName}</strong>
                  <small>
                    {preview
                      ? "Design preview"
                      : (user?.roles[0] ?? "User")
                          .toLowerCase()
                          .replaceAll("_", " ")}
                  </small>
                </span>
                <ChevronDown size={15} />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={12}
                  className="account-dropdown"
                >
                  <DropdownMenu.Label className="account-dropdown-label">
                    {preview ? "UI preview · no business records" : user?.login}
                  </DropdownMenu.Label>
                  {deviceMenu}
                  {preview ? (
                    <DropdownMenu.Item asChild>
                      <Link href="/login" className="account-dropdown-item">
                        <BatteryCharging size={16} />
                        Sign in
                      </Link>
                    </DropdownMenu.Item>
                  ) : (
                    <DropdownMenu.Item
                      disabled={loggingOut}
                      className="account-dropdown-item"
                      onSelect={() => void logout()}
                    >
                      <LogOut size={16} />
                      Sign out
                    </DropdownMenu.Item>
                  )}
                  {logoutError ? (
                    <p role="alert" className="p-3 text-xs text-red-600">
                      {logoutError}
                    </p>
                  ) : null}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </header>
        {preview ? (
          <div className="preview-banner">
            <ClipboardList size={14} />
            <span>
              <strong>UI preview</strong> · কোনো নমুনা হিসাব বা লাইভ রেকর্ড নয়
            </span>
            <Link href="/login">Sign in ↗</Link>
          </div>
        ) : null}
        {deviceStatus}
        <main id="main-content" className="main-content">
          <div
            className="workspace-content"
            ref={contentRef}
            inert={!preview && !user}
            aria-busy={!preview && !user}
          >
            {children}
          </div>
        </main>
        {quickAccess.length > 0 ? (
          <nav
            aria-label="Quick access"
            className="mobile-quick-access"
            inert={!preview && !user}
          >
            {quickAccess.map((item) => {
              const moduleId = item.href.slice(1);
              const active = moduleId === current;
              return (
                <Link
                  key={item.href}
                  href={workspaceHref(moduleId, "", preview)}
                  prefetch={true}
                  className={cn("quick-access-link", active && "active")}
                  aria-current={active ? "page" : undefined}
                >
                  <item.icon size={21} strokeWidth={1.8} aria-hidden="true" />
                  <span>{quickAccessLabels[item.href]}</span>
                </Link>
              );
            })}
          </nav>
        ) : null}
      </div>
    </div>
  );
}
