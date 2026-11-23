import { createContext, useContext } from "react";

export const NavigationContext = createContext({
  pathname: "/dashboard",
  navigate: (async () => {}) as (
    href: string,
    replace?: boolean,
  ) => Promise<void>,
});
export function usePathname() {
  return useContext(NavigationContext).pathname.split("?")[0];
}
export function useSearchParams() {
  return new URLSearchParams(
    useContext(NavigationContext).pathname.split("?")[1] ?? "",
  );
}
export function useRouter() {
  const { navigate } = useContext(NavigationContext);
  return {
    push: (href: string) => void navigate(href),
    replace: (href: string) => void navigate(href, true),
    refresh: () => window.dispatchEvent(new Event("focus")),
    back: () => void navigate("__back__"),
    prefetch: () => {},
  };
}
