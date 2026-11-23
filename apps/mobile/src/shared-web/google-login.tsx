"use dom";
import type { DOMProps } from "expo/dom";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-bengali";
import "../../../web/src/app/globals.css";
import { LoginForm } from "../../../web/src/components/login-form";
export default function GoogleLogin({
  busy,
  pending,
  error,
  saved,
  onGoogle,
  onSaved,
}: {
  dom?: DOMProps;
  busy: boolean;
  pending: boolean;
  error: string;
  saved: boolean;
  onGoogle: () => Promise<void>;
  onSaved: () => Promise<void>;
}) {
  return (
    <LoginForm
      googleLogin={{
        busy,
        pending,
        error,
        saved,
        onClick: () => void onGoogle(),
        onSaved: () => void onSaved(),
      }}
    />
  );
}
