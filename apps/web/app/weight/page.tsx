import type { Metadata } from "next";
import { getWeightPageData, getUserById, todayDateString } from "@macro-tracker/db";

import { WeightShell } from "@/components/weight-shell";
import { requireSessionUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Weight | Macro Tracker",
};

export default async function WeightPage() {
  const sessionUser = await requireSessionUser();
  const today = todayDateString();

  const [weightData, user] = await Promise.all([
    getWeightPageData(sessionUser.userId, today),
    getUserById(sessionUser.userId),
  ]);

  return (
    <WeightShell
      userEmail={user?.email ?? sessionUser.email}
      today={today}
      weightData={weightData}
    />
  );
}
