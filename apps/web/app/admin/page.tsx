import Link from "next/link";

import { getAdminDashboardData, isOwnerRole } from "@macro-tracker/db";

import {
  AdminNotice,
  AdminRoleBadge,
  AdminSection,
  AdminStatCard,
  formatAdminTimestamp,
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
                    <th className="pb-3 pr-4">Submitter</th>
                    <th className="pb-3 pr-4">Status</th>
                    <th className="pb-3">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {dashboard.recentBarcodeAdditions.map((item) => (
                    <tr key={item.id}>
                      <td className="py-3 pr-4">
                        <Link
                          href={`/admin/barcodes/${item.id}`}
                          className="font-semibold text-[var(--color-ink)] underline-offset-4 hover:underline"
                        >
                          {item.name}
                        </Link>
                      </td>
                      <td className="py-3 pr-4 font-mono text-xs text-[var(--color-muted)]">
                        {item.barcode}
                      </td>
                      <td className="py-3 pr-4 text-[var(--color-muted)]">
                        {item.addedByEmail ?? "Unknown"}
                      </td>
                      <td className="py-3 pr-4">
                        <span className="rounded-full bg-[var(--color-card-muted)] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-strong)]">
                          {item.status}
                        </span>
                      </td>
                      <td className="py-3 text-[var(--color-muted)]">
                        {formatAdminTimestamp(item.createdAt)}
                      </td>
                    </tr>
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
                <div
                  key={event.id}
                  className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="font-semibold text-[var(--color-ink)]">
                        {event.action}
                      </p>
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
          )}
        </AdminSection>
      ) : null}
    </div>
  );
}
