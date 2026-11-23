import type { ImgHTMLAttributes } from "react";
export default function Image({
  unoptimized: _unoptimized,
  fill,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & {
  unoptimized?: boolean;
  fill?: boolean;
}) {
  void _unoptimized;
  return (
    <img
      {...props}
      alt={props.alt ?? ""}
      style={{
        ...(fill
          ? { position: "absolute", inset: 0, width: "100%", height: "100%" }
          : {}),
        ...props.style,
      }}
    />
  );
}
