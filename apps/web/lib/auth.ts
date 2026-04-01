import { getUserById } from "@macro-tracker/db";
import { redirect } from "next/navigation";

import { getSessionUserFromCookies } from "./session";

export async function getCurrentSessionUser() {
  const user = await getSessionUserFromCookies();

  if (!user) {
    return null;
  }

  const existingUser = await getUserById(user.userId);
  if (!existingUser) {
    return null;
  }

  return user;
}

export async function requireSessionUser() {
  const user = await getCurrentSessionUser();

  if (!user) {
    redirect("/api/auth/logout?expired=1");
  }

  return user;
}
