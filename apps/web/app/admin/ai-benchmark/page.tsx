import type { Metadata } from "next";

import { AdminAiBenchmarkClient } from "@/components/admin-ai-benchmark-client";
import { AdminSection } from "@/components/admin-ui";
import { getConfiguredFoodPhotoModel } from "@/lib/ai-food-photo";

export const metadata: Metadata = {
  title: "AI Benchmark | Macro Tracker Admin",
};

export default function AdminAiBenchmarkPage() {
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
