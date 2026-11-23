export type BridgeRequest = {
  route: string;
  method: string;
  body?: unknown;
  key?: string;
};
export type BridgeResult =
  { ok: true; data: unknown } | { ok: false; status: number; message: string };
