import { forwardRef, type AnchorHTMLAttributes } from "react";
import { useRouter } from "./navigation";

export default forwardRef<
  HTMLAnchorElement,
  AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    prefetch?: boolean;
    replace?: boolean;
  }
>(function Link(
  { href, onClick, prefetch: _prefetch, replace, ...props },
  ref,
) {
  const router = useRouter();
  void _prefetch;
  return (
    <a
      {...props}
      ref={ref}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.ctrlKey ||
          event.metaKey ||
          props.target === "_blank"
        )
          return;
        if (!href.startsWith("/") || href.startsWith("//")) return;
        event.preventDefault();
        if (replace) router.replace(href);
        else router.push(href);
      }}
    />
  );
});
