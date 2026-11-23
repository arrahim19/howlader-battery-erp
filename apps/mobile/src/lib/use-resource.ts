import { useCallback, useEffect, useState } from "react";
import { useFocusEffect } from "expo-router";
import { useSession } from "./session";
import { ApiError } from "./client";

export function useResource<T>(path: string | null) {
  const { user, local, syncStatus } = useSession();
  const [state, setState] = useState<{
    data: T | null;
    error: string;
    scope: string;
    revision: number;
  }>({ data: null, error: "", scope: "", revision: -1 });
  const [revision, setRevision] = useState(0);
  const scope = `${local?.scope ?? ""}:${path ?? ""}`;
  useFocusEffect(
    useCallback(() => {
      setRevision((value) => value + 1);
    }, []),
  );
  useEffect(() => {
    if (!path || !user || !local) return;
    const controller = new AbortController();
    let received = false;
    void local
      .cached<T>(path)
      .then((saved) => {
        if (saved && !received && !controller.signal.aborted)
          setState({
            data: saved.data,
            error: "",
            scope,
            revision: revision - 1,
          });
      })
      .catch(() => {
        /* The read below reports local storage failures. */
      });
    local
      .read<T>(path, controller.signal)
      .then(({ data }) => {
        received = true;
        if (!controller.signal.aborted)
          setState({ data, error: "", scope, revision });
      })
      .catch((error: unknown) => {
        received = true;
        if (!controller.signal.aborted)
          setState((old) => ({
            ...old,
            data:
              error instanceof ApiError &&
              [401, 403, 404].includes(error.status)
                ? null
                : old.scope === scope
                  ? old.data
                  : null,
            scope,
            revision,
            error:
              error instanceof Error ? error.message : "Unable to load data.",
          }));
      });
    return () => controller.abort();
  }, [local, path, user, revision, scope, syncStatus.lastSync]);
  const valid = state.scope === scope;
  return {
    data: valid ? state.data : null,
    error: valid ? state.error : "",
    loading: Boolean(path && user && (!valid || state.revision !== revision)),
    refresh: () => setRevision((value) => value + 1),
  };
}
