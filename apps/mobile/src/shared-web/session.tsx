import { createContext, useContext } from "react";
import type { CurrentUser } from "../../../web/src/lib/api";
export const MobileUserContext = createContext<CurrentUser | null>(null);
export const useSession = () => useContext(MobileUserContext);
