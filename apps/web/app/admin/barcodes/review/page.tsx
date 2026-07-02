import Link from "next/link";

import {
  listAdminBarcodeReviewQueue,
  type AdminBarcodeReviewReason,
} from "@macro-tracker/db";

import {
  AdminNotice,
  AdminPaginationLinks,
  AdminSection,
  formatAdminTimestamp,
} from "@/components/admin-ui";

type AdminBarcodeReviewPageProps = {
  searchParams: Promise<{
    page?: string;
  }>;
};

const reasonLabels: Record<AdminBarcodeReviewReason, string> = {
  low_confidence: "Low confidence",
  missing_serving_size: "Missing serving size",
  recently_deleted: "Recently deleted",
  recently_restored: "Recently restored",
  duplicate_name: "Duplicate name",
  frequent_revisions: "Frequent revisions",
};

export default async function AdminBarcodeReviewPage({
  searchParams,
}: AdminBarcodeReviewPageProps) {
  const params = await searchParams;
  const page = Number(params.page ?? "1");
  const queue = await listAdminBarcodeReviewQueue({
    page: Number.isFinite(page) ? page : 1,
    pageSize: 25,
  });

  return (
    <div className="space-y-6">
      <AdminSection
        title="Barcode Review Queue"
        description="Computed moderation signals for shared barcode records that may need a closer look."
      >
        {queue.items.length === 0 ? (
          <AdminNotice>No barcode records currently match review rules.</AdminNotice>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
                <tr>
                  <th className="pb-3 pr-4">Product</th>
                  <th className="pb-3 pr-4">Reasons</th>
                  <th className="pb-3 pr-4">Confidence</th>
                  <th className="pb-3 pr-4">Revisions</th>
                  <th className="pb-3">Last signal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {queue.items.map((item) => (
                  <tr key={item.id}>
                    <td className="py-3 pr-4">
                      <Link
                        href={`/admin/barcodes/${item.id}`}
                        className="font-semibold text-[var(--color-ink)] underline-offset-4 hover:underline"
                      >
                        {item.name}
                      </Link>
                      <p className="mt-1 font-mono text-xs text-[var(--color-muted)]">
                        {item.barcode}
                      </p>
                      {item.brand ? (
                        <p className="mt-1 text-xs text-[var(--color-muted)]">
                          {item.brand}
                        </p>
                      ) : null}
                    </td>
                    <td className="py-3 pr-4">
                      <div className="flex flex-wrap gap-1.5">
                        {item.reviewReasons.map((reason) => (
                          <span
                            key={reason}
                            className="rounded-full bg-[var(--color-card-muted)] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-muted-strong)]"
                          >
                            {reasonLabels[reason]}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-[var(--color-muted)]">
                      {item.sourceConfidence != null
                        ? `${Math.round(item.sourceConfidence * 100)}%`
                        : "-"}
                    </td>
                    <td className="py-3 pr-4 text-[var(--color-muted)]">
                      {item.revisionCount30Days} in 30 days
                    </td>
                    <td className="py-3 text-[var(--color-muted)]">
                      {item.latestAuditAt
                        ? `${item.latestAuditAction ?? "audit"} - ${formatAdminTimestamp(
                            item.latestAuditAt,
                          )}`
                        : formatAdminTimestamp(item.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <AdminPaginationLinks
          pathname="/admin/barcodes/review"
          searchParams={{}}
          pagination={queue.pagination}
        />
      </AdminSection>
    </div>
  );
}
