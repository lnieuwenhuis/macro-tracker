import { getGymPageData } from "@macro-tracker/db";

import { GymShell } from "@/components/gym-shell";
import { loadOnboardedPageContext } from "@/lib/page-context";

type GymPageProps = {
  searchParams: Promise<{
    date?: string;
  }>;
};

export default async function GymPage({ searchParams }: GymPageProps) {
  const { sessionUser, selectedDate, userEmail, canAccessAdmin, today } =
    await loadOnboardedPageContext(searchParams);

  const data = await getGymPageData(sessionUser.userId, selectedDate);

  return (
    <GymShell
      key={selectedDate}
      userEmail={userEmail}
      canAccessAdmin={canAccessAdmin}
      selectedDate={selectedDate}
      todayStr={today}
      data={data}
    />
  );
}
