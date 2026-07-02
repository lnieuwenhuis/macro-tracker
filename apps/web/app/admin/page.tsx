import Link from "next/link";

import { getAdminDashboardData, isOwnerRole } from "@macro-tracker/db";

import {
  AdminAuditEventCard,
  AdminBarcodeProductRow,
  AdminNotice,
  AdminRoleBadge,
  AdminSection,
  AdminStatCard,
} from "@/components/admin-ui";
import { requireAdminUser } from "@/lib/auth";

export default async function AdminDashboardPage() {
  const adminUser = await requireAdminUser();
  const dashboard = await getAdminDashboardData();

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AdminStatCard label="Users" value={String(dashboard.totalUsers)} />
        <AdminStatCard
          label="Owners / Admins"
          value={`${dashboard.ownerCount} / ${dashboard.adminCount}`}
          sub="privileged accounts"
        />
        <AdminStatCard
          label="New Users"
          value={String(dashboard.newUsersLast7Days)}
          sub="last 7 days"
        />
        <AdminStatCard
          label="Active Users"
          value={String(dashboard.activeUsersLast7Days)}
          sub="logged in during the last 7 days"
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <AdminStatCard
          label="Active Barcodes"
          value={String(dashboard.activeBarcodeCount)}
        />
        <AdminStatCard
          label="Deleted Barcodes"
          value={String(dashboard.deletedBarcodeCount)}
          sub="soft deleted and restorable"
        />
      </div>

      <AdminSection
        title="User Health"
        description="Operational friction signals that link into filtered user lists."
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {dashboard.health.segments.map((segment) => (
            <Link
              key={segment.id}
              href={segment.href}
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] p-4 transition hover:-translate-y-0.5 hover:bg-[var(--color-card-muted)]"
            >
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
                {segment.label}
              </p>
              <p className="mt-2 text-3xl font-bold text-[var(--color-ink)]">
                {segment.count}
              </p>
            </Link>
          ))}
        </div>
      </AdminSection>

      <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <AdminSection
          title="Recent Barcode Additions"
          description="Newest records in the shared catalogue."
          action={
            <Link
              href="/admin/barcodes"
              className="rounded-full border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] transition hover:bg-[var(--color-card-muted)]"
            >
              Manage barcodes
            </Link>
          }
        >
          {dashboard.recentBarcodeAdditions.length === 0 ? (
            <AdminNotice>No barcode products have been added yet.</AdminNotice>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
                  <tr>
                    <th className="pb-3 pr-4">Product</th>
                    <th className="pb-3 pr-4">Barcode</th>
                    <th className="pb-3 pr-4">Source</th>
                    <th className="pb-3 pr-4">Status</th>
                    <th className="pb-3">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {dashboard.recentBarcodeAdditions.map((item) => (
                    <AdminBarcodeProductRow key={item.id} product={item} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AdminSection>

        <AdminSection
          title="Privilege Snapshot"
          description="Current access model and escalation boundaries."
        >
          <div className="space-y-3 text-sm text-[var(--color-muted)]">
            <p>
              You are signed in as <span className="font-semibold text-[var(--color-ink)]">{adminUser.email}</span>.
            </p>
            <div className="flex items-center gap-2">
              <span>Current role:</span>
              <AdminRoleBadge role={adminUser.role} />
            </div>
            <p>
              Admins can inspect users and moderate barcode data. Owners can also
              manage roles and access the full audit feed.
            </p>
          </div>
        </AdminSection>
      </div>

      {isOwnerRole(adminUser.role) ? (
        <AdminSection
          title="Recent Audit Events"
          description="Latest privileged actions across the admin panel."
          action={
            <Link
              href="/admin/audit"
              className="rounded-full border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] transition hover:bg-[var(--color-card-muted)]"
            >
              View audit log
            </Link>
          }
        >
          {dashboard.recentAuditEvents.length === 0 ? (
            <AdminNotice>No audit events have been recorded yet.</AdminNotice>
          ) : (
            <div className="space-y-3">
              {dashboard.recentAuditEvents.map((event) => (
                <AdminAuditEventCard key={event.id} event={event} />
              ))}
            </div>
          )}
        </AdminSection>
      ) : null}
    </div>
  );
}
