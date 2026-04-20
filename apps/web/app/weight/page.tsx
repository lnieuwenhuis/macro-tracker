import type { Metadata } from "next";
import { canAccessAdmin, ensureDateString, getWeightPageData, getUserById } from "@macro-tracker/db";
import { redirect } from "next/navigation";

import { WeightShell } from "@/components/weight-shell";
import { requireSessionUser } from "@/lib/auth";
import { getServerUiMode } from "@/lib/ui-mode-server";

export const metadata: Metadata = {
  title: "Weight | Macro Tracker",
};

type WeightPageProps = {
  searchParams: Promise<{ date?: string }>;
};

export default async function WeightPage({ searchParams }: WeightPageProps) {
  const sessionUser = await requireSessionUser();
  const params = await searchParams;
  const selectedDate = ensureDateString(params.date);
  const uiMode = await getServerUiMode();

  if (uiMode === "experimental") {
    redirect(`/progress?date=${selectedDate}&tab=weight`);
  }

  const [weightData, user] = await Promise.all([
    getWeightPageData(sessionUser.userId, selectedDate),
    getUserById(sessionUser.userId),
  ]);

  return (
    <WeightShell
      userEmail={user?.email ?? sessionUser.email}
      canAccessAdmin={user ? canAccessAdmin(user.role) : false}
      selectedDate={selectedDate}
      weightData={weightData}
    />
  );
}
