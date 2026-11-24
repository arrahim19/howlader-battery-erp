import Image from "next/image";
import { brandImage } from "@/lib/brand-image";

export function BrandLogo({
  className = "",
  size = 40,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <Image
      src={brandImage}
      alt="Hawlader Battery House logo"
      width={size}
      height={size}
      className={`brand-logo ${className}`}
      unoptimized
      loading="eager"
    />
  );
}
