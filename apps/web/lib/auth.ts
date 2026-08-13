import {
  canAccessAdmin,
  getUserById,
  isOwnerRole,
  reconcileConfiguredOwner,
  type AppUser,
} from "@macro-tracker/db";
import { notFound, redirect } from "next/navigation";

import { getServerEnv } from "./env";
import { getSessionUserFromCookies } from "./session";

async function applyBootstrapOwnerRole(user: AppUser) {
  const { adminOwnerEmails } = getServerEnv();

  if (!adminOwnerEmails.includes(user.email.toLowerCase()) || user.role === "owner") {
    return user;
  }

  // The backend re-checks the address against its own ADMIN_OWNER_EMAILS, so
  // the promotion decision is never taken from this side.
  return (await reconcileConfiguredOwner(user.id)) ?? user;
}

export async function getCurrentAppUser() {
  const sessionUser = await getSessionUserFromCookies();

  if (!sessionUser) {
    return null;
  }

  const existingUser = await getUserById(sessionUser.userId);
  if (!existingUser) {
    return null;
  }

  return applyBootstrapOwnerRole(existingUser);
}

export async function getCurrentSessionUser() {
  const user = await getCurrentAppUser();

  if (!user) {
    return null;
  }

  return {
    userId: user.id,
    email: user.email,
  };
}

export async function requireSessionUser() {
  const user = await getCurrentSessionUser();

  if (!user) {
    redirect("/api/auth/logout?expired=1");
  }

  return user;
}

/**
 * Resolve the full onboarded account. Callers that also need the role or email
 * should use this rather than pairing `requireOnboardedSessionUser` with a
 * second `getUserById`, which costs an extra backend round trip per render.
 */
export async function requireOnboardedAppUser() {
  const user = await getCurrentAppUser();

  if (!user) {
    redirect("/api/auth/logout?expired=1");
  }

  if (!user.onboardingCompletedAt) {
    redirect("/onboarding");
  }

  return user;
}

export async function requireOnboardedSessionUser() {
  const user = await requireOnboardedAppUser();

  return {
    userId: user.id,
    email: user.email,
  };
}

export async function requireAdminUser() {
  const user = await getCurrentAppUser();

  if (!user) {
    redirect("/api/auth/logout?expired=1");
  }

  if (!canAccessAdmin(user.role)) {
    notFound();
  }

  return user;
}

export async function requireOwnerUser() {
  const user = await getCurrentAppUser();

  if (!user) {
    redirect("/api/auth/logout?expired=1");
  }

  if (!isOwnerRole(user.role)) {
    notFound();
  }

  return user;
}
