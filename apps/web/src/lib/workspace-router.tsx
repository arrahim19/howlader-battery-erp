"use client";
import { createContext, useContext } from "react";
import {
  usePathname as nextPathname,
  useRouter as nextRouter,
  useSearchParams as nextSearchParams,
} from "next/navigation";
export const DeviceNavigation = createContext<{
  pathname: string;
  navigate: (href: string, replace?: boolean) => void;
} | null>(null);
export function usePathname() {
  const context = useContext(DeviceNavigation),
    fallback = nextPathname();
  return context ? context.pathname.split("?")[0] : fallback;
}
export function useSearchParams() {
  const context = useContext(DeviceNavigation),
    fallback = nextSearchParams();
  return context
    ? new URLSearchParams(context.pathname.split("?")[1] || "")
    : fallback;
}
export function useRouter() {
  const context = useContext(DeviceNavigation),
    fallback = nextRouter();
  return context
    ? {
        push: (href: string) => context.navigate(href),
        replace: (href: string) => context.navigate(href, true),
        back: () => context.navigate("__back__"),
        refresh: () => window.dispatchEvent(new Event("focus")),
        prefetch: () => {},
      }
    : fallback;
}
