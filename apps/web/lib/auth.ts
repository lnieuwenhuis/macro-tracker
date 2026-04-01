import { redirect } from "next/navigation";

import { getSessionUserFromCookies } from "./session";

export async function getCurrentSessionUser() {
  return getSessionUserFromCookies();
}

export async function requireSessionUser() {
  const user = await getCurrentSessionUser();

  if (!user) {
    redirect("/login");
  }

  return user;
}
