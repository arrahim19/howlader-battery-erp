"use client";
import { useEffect, type Dispatch, type SetStateAction } from "react";
import { api } from "@/lib/api";

/** Replace an offline reference only after the device's journal has a server receipt. */
export function useLocalReceipt<
  T extends { id: string; syncStatus?: "PENDING" },
>(
  value: T | null,
  setValue: Dispatch<SetStateAction<T | null>>,
  onError: (message: string) => void,
) {
  const id = value?.id,
    pending = value?.syncStatus === "PENDING";
  useEffect(() => {
    if (!id || !pending) return;
    let alive = true;
    const check = async () => {
      try {
        const result = await api<T>(
          "/__local/receipt?id=" + encodeURIComponent(id),
        );
        if (alive && result.syncStatus !== "PENDING")
          setValue((previous) =>
            previous?.id === id
              ? { ...previous, ...result, syncStatus: undefined }
              : previous,
          );
      } catch (failure) {
        if (alive)
          onError(
            failure instanceof Error
              ? failure.message
              : "This local operation needs review.",
          );
      }
    };
    void check();
    window.addEventListener("focus", check);
    return () => {
      alive = false;
      window.removeEventListener("focus", check);
    };
  }, [id, pending, setValue, onError]);
}
