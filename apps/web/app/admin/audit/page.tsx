import { listAdminAuditEvents } from "@macro-tracker/db";

import {
  AdminAuditEventCard,
  AdminPaginationLinks,
  AdminSection,
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
  const ownerUser = await requireOwnerUser();
  const params = await searchParams;
  const page = Number(params.page ?? "1");
  const audit = await listAdminAuditEvents(ownerUser.id, {
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
            <AdminAuditEventCard key={event.id} event={event} layout="wide" />
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
