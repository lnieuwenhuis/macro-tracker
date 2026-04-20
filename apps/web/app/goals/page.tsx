import { canAccessAdmin, ensureDateString, getUserGoals, getUserById } from "@macro-tracker/db";
import { redirect } from "next/navigation";

import { GoalsShell } from "@/components/goals-shell";
import { requireSessionUser } from "@/lib/auth";
import { getServerUiMode } from "@/lib/ui-mode-server";

type GoalsPageProps = {
  searchParams: Promise<{ date?: string }>;
};

export default async function GoalsPage({ searchParams }: GoalsPageProps) {
  const sessionUser = await requireSessionUser();
  const params = await searchParams;
  const selectedDate = ensureDateString(params.date);
  const uiMode = await getServerUiMode();

  if (uiMode === "experimental") {
    redirect(`/progress?date=${selectedDate}&tab=goals`);
  }

  const [goals, user] = await Promise.all([
    getUserGoals(sessionUser.userId),
    getUserById(sessionUser.userId),
  ]);

  return (
    <GoalsShell
      userEmail={user?.email ?? sessionUser.email}
      canAccessAdmin={user ? canAccessAdmin(user.role) : false}
      selectedDate={selectedDate}
      goals={goals}
    />
  );
}
