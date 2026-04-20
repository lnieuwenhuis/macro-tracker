import { cookies } from "next/headers";

import { DEFAULT_UI_MODE, UI_MODE_COOKIE_NAME, normalizeUiMode, type UiMode } from "./ui-mode";

export async function getServerUiMode(): Promise<UiMode> {
  const cookieStore = await cookies();
  return normalizeUiMode(cookieStore.get(UI_MODE_COOKIE_NAME)?.value ?? DEFAULT_UI_MODE);
}
