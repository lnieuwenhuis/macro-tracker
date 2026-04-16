import { listAdminAuditEvents } from "@macro-tracker/db";

import {
  AdminPaginationLinks,
  AdminRoleBadge,
  AdminSection,
  formatAdminTimestamp,
} from "@/components/admin-ui";
import { requireOwnerUser } from "@/lib/auth";

type AdminAuditPageProps = {
  searchParams: Promise<{
    page?: string;
  }>;
};

export default async function AdminAuditPage({
  searchParams,
}: AdminAuditPageProps) {
  await requireOwnerUser();
  const params = await searchParams;
  const page = Number(params.page ?? "1");
  const audit = await listAdminAuditEvents({
    page: Number.isFinite(page) ? page : 1,
    pageSize: 25,
  });

  return (
    <div className="space-y-6">
      <AdminSection
        title="Audit Log"
        description="Owner-only record of privileged actions taken in the admin panel."
      >
        <div className="space-y-3">
          {audit.items.map((event) => (
            <div
              key={event.id}
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3"
            >
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="font-semibold text-[var(--color-ink)]">{event.action}</p>
                  <p className="mt-1 text-sm text-[var(--color-muted)]">
                    {event.actorEmail ?? "Unknown user"} on {event.targetType}{" "}
                    <span className="font-mono text-xs">{event.targetId}</span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <AdminRoleBadge role={event.actorRole} />
                  <span className="text-xs text-[var(--color-muted)]">
                    {formatAdminTimestamp(event.createdAt)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>

        <AdminPaginationLinks
          pathname="/admin/audit"
          searchParams={{}}
          pagination={audit.pagination}
        />
      </AdminSection>
    </div>
  );
}
