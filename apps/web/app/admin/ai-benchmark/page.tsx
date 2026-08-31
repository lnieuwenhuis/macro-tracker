import type { Metadata } from "next";

import { AdminAiBenchmarkClient } from "@/components/admin-ai-benchmark-client";
import { AdminSection } from "@/components/admin-ui";
import { getConfiguredFoodPhotoModel } from "@/lib/ai-food-photo";
import { requireAdminUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "AI Benchmark | Macro Tracker Admin",
};

export default async function AdminAiBenchmarkPage() {
  // Every sibling admin page gates itself rather than trusting the layout:
  // layouts do not re-render on navigation, and the router state tree that
  // drives partial rendering is client-supplied.
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
