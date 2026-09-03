import type { Metadata } from "next";

import { AdminAiBenchmarkClient } from "@/components/admin-ai-benchmark-client";
import { AdminSection } from "@/components/admin-ui";
import { getConfiguredFoodPhotoModel } from "@/lib/ai-food-photo";
import { requireAdminUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "AI Benchmark | Macro Tracker Admin",
};

export default async function AdminAiBenchmarkPage() {
  // Gates itself rather than trusting the layout: router state is client-supplied and layouts don't re-render on nav.
  await requireAdminUser();

  const currentModel = getConfiguredFoodPhotoModel();

  return (
    <div className="space-y-6">
      <AdminSection
        title="AI Model Benchmark"
        description="Compare a candidate vision model against the configured production food-photo model."
      >
        <AdminAiBenchmarkClient currentModel={currentModel} />
      </AdminSection>
    </div>
  );
}
