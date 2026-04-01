import { ensureDateString, getUserGoals, getUserById } from "@macro-tracker/db";

import { GoalsShell } from "@/components/goals-shell";
import { requireSessionUser } from "@/lib/auth";

type GoalsPageProps = {
  searchParams: Promise<{ date?: string }>;
};

export default async function GoalsPage({ searchParams }: GoalsPageProps) {
  const sessionUser = await requireSessionUser();
  const params = await searchParams;
  const selectedDate = ensureDateString(params.date);

  const [goals, user] = await Promise.all([
    getUserGoals(sessionUser.userId),
    getUserById(sessionUser.userId),
  ]);

  return (
    <GoalsShell
      userEmail={user?.email ?? sessionUser.email}
      selectedDate={selectedDate}
      goals={goals}
    />
  );
}
