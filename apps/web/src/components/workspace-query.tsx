"use client";

import { useSearchParams } from "@/lib/workspace-router";
import { ModulePage } from "@/components/module-page";

export function WorkspaceQuery({
  moduleId,
  subpage,
}: {
  moduleId: string;
  subpage: string;
}) {
  const customer = useSearchParams().get("customer") ?? undefined;
  return (
    <ModulePage
      key={moduleId + "/" + subpage + ":" + (customer ?? "")}
      module={moduleId}
      subpage={subpage}
      initialCustomerId={customer}
    />
  );
}
