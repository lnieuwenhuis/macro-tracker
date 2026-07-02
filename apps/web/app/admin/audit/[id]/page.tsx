import Link from "next/link";
import { notFound } from "next/navigation";

import { getAdminAuditEventById } from "@macro-tracker/db";

import {
  AdminRoleBadge,
  AdminSection,
  formatAdminTimestamp,
} from "@/components/admin-ui";
import { requireOwnerUser } from "@/lib/auth";

type AdminAuditDetailPageProps = {
  params: Promise<{ id: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatDetailValue(value: unknown) {
  if (value == null) {
    return "-";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

function buildDiffRows(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  return Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
    .sort()
    .map((key) => ({
      key,
      before: before[key],
      after: after[key],
    }))
    .filter(
      (row) =>
        JSON.stringify(row.before ?? null) !== JSON.stringify(row.after ?? null),
    );
}

export default async function AdminAuditDetailPage({
  params,
}: AdminAuditDetailPageProps) {
  await requireOwnerUser();
  const { id } = await params;
  const event = await getAdminAuditEventById(id);

  if (!event) {
    notFound();
  }

  const before = isRecord(event.details.before) ? event.details.before : null;
  const after = isRecord(event.details.after) ? event.details.after : null;
  const diffRows = before && after ? buildDiffRows(before, after) : [];
  const detailRows = Object.entries(event.details).filter(
    ([key]) => key !== "before" && key !== "after",
  );

  return (
    <div className="space-y-6">
      <Link
        href="/admin/audit"
        className="inline-flex rounded-full border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] transition hover:bg-[var(--color-card-muted)]"
      >
        Back to audit log
      </Link>

      <AdminSection
        title={event.action}
        description="Owner-only detail for a privileged admin action."
        action={<AdminRoleBadge role={event.actorRole} />}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Actor", event.actorEmail ?? "Unknown user"],
            ["Target", `${event.targetType} ${event.targetId}`],
            ["When", formatAdminTimestamp(event.createdAt)],
            ["Role", event.actorRole],
          ].map(([label, value]) => (
            <div
              key={label}
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] p-4"
            >
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
                {label}
              </p>
              <p className="mt-2 break-words text-sm font-semibold text-[var(--color-ink)]">
                {value}
              </p>
            </div>
          ))}
        </div>
      </AdminSection>

      {before && after ? (
        <AdminSection
          title="Before / After"
          description="Changed fields from the audit event details."
        >
          {diffRows.length === 0 ? (
            <p className="text-sm text-[var(--color-muted)]">
              No changed fields were detected in this diff.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
                  <tr>
                    <th className="pb-3 pr-4">Field</th>
                    <th className="pb-3 pr-4">Before</th>
                    <th className="pb-3">After</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {diffRows.map((row) => (
                    <tr key={row.key}>
                      <td className="py-3 pr-4 font-mono text-xs text-[var(--color-muted-strong)]">
                        {row.key}
                      </td>
                      <td className="whitespace-pre-wrap py-3 pr-4 text-[var(--color-muted)]">
                        {formatDetailValue(row.before)}
                      </td>
                      <td className="whitespace-pre-wrap py-3 text-[var(--color-ink)]">
                        {formatDetailValue(row.after)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AdminSection>
      ) : null}

      <AdminSection
        title="Details"
        description="Structured metadata captured with the audit event."
      >
        {detailRows.length === 0 && !before && !after ? (
          <p className="text-sm text-[var(--color-muted)]">
            No additional details were recorded.
          </p>
        ) : (
          <div className="space-y-3">
            {detailRows.map(([key, value]) => (
              <div
                key={key}
                className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] p-4"
              >
                <p className="font-mono text-xs font-semibold text-[var(--color-muted-strong)]">
                  {key}
                </p>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-[var(--color-ink)]">
                  {formatDetailValue(value)}
                </p>
              </div>
            ))}
          </div>
        )}
      </AdminSection>
    </div>
  );
}
