type BackActions = {
  canGoBack: () => boolean;
  back: () => void;
  home: () => void;
  lock: () => Promise<void>;
  exit: () => void;
};

export function handleDeviceBack(pathname: string, actions: BackActions) {
  if (pathname === "/login") {
    actions.exit();
    return true;
  }
  if (pathname === "/dashboard") {
    // Android 12+ may retain the root activity after Back. Lock before handing
    // control to Android, so a warm resume also requires the password.
    void actions.lock().then(actions.exit, actions.exit);
    return true;
  }
  if (actions.canGoBack()) actions.back();
  else actions.home();
  return true;
}
