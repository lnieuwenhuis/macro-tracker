import { notFound } from "next/navigation";

import { getAdminBarcodeProductById, listAdminAuditEvents } from "@macro-tracker/db";

import {
  AdminNotice,
  AdminSection,
  formatAdminTimestamp,
} from "@/components/admin-ui";
import {
  restoreAdminBarcodeProductAction,
  softDeleteAdminBarcodeProductAction,
  updateAdminBarcodeProductAction,
} from "@/lib/admin-actions";

type AdminBarcodeDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    saved?: string;
    error?: string;
  }>;
};

function EditField({
  label,
  name,
  defaultValue,
  type = "text",
  step,
  required = false,
}: {
  label: string;
  name: string;
  defaultValue: string | number;
  type?: string;
  step?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
        {label}
      </span>
      <input
        type={type}
        name={name}
        defaultValue={defaultValue}
        step={step}
        required={required}
        className="w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
      />
    </label>
  );
}

export default async function AdminBarcodeDetailPage({
  params,
  searchParams,
}: AdminBarcodeDetailPageProps) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const [barcode, audit] = await Promise.all([
    getAdminBarcodeProductById(id),
    listAdminAuditEvents({
      targetType: "barcode_product",
      targetId: id,
      page: 1,
      pageSize: 10,
    }),
  ]);

  if (!barcode) {
    notFound();
  }

  return (
    <div className="space-y-6">
      {query.saved === "created" ? (
        <AdminNotice tone="success">Barcode created.</AdminNotice>
      ) : null}
      {query.saved === "updated" ? (
        <AdminNotice tone="success">Barcode updated.</AdminNotice>
      ) : null}
      {query.saved === "deleted" ? (
        <AdminNotice tone="success">Barcode soft deleted.</AdminNotice>
      ) : null}
      {query.saved === "restored" ? (
        <AdminNotice tone="success">Barcode restored.</AdminNotice>
      ) : null}
      {query.error ? <AdminNotice tone="error">{query.error}</AdminNotice> : null}

      <AdminSection
        title={barcode.name}
        description={`${barcode.barcode} • ${barcode.status}`}
      >
        <form action={updateAdminBarcodeProductAction} className="grid gap-4 lg:grid-cols-2">
          <input type="hidden" name="id" value={barcode.id} />
          <EditField label="Barcode" name="barcode" defaultValue={barcode.barcode} required />
          <EditField label="Name" name="name" defaultValue={barcode.name} required />
          <EditField label="Brand" name="brands" defaultValue={barcode.brands} />
          <EditField
            label="Serving size (g)"
            name="servingSizeG"
            defaultValue={barcode.servingSizeG ?? ""}
            type="number"
            step="0.1"
          />
          <EditField
            label="Protein (g)"
            name="proteinG"
            defaultValue={barcode.proteinG}
            type="number"
            step="0.1"
            required
          />
          <EditField
            label="Carbs (g)"
            name="carbsG"
            defaultValue={barcode.carbsG}
            type="number"
            step="0.1"
            required
          />
          <EditField
            label="Fat (g)"
            name="fatG"
            defaultValue={barcode.fatG}
            type="number"
            step="0.1"
            required
          />
          <EditField
            label="Calories"
            name="caloriesKcal"
            defaultValue={barcode.caloriesKcal}
            type="number"
            step="1"
            required
          />
          <div className="lg:col-span-2 flex flex-wrap gap-3">
            <button
              type="submit"
              className="rounded-2xl bg-[var(--color-accent)] px-5 py-3 text-sm font-semibold text-white transition hover:opacity-90"
            >
              Save changes
            </button>
            {barcode.deletedAt ? (
              <button
                type="submit"
                formAction={restoreAdminBarcodeProductAction}
                className="rounded-2xl border border-[var(--color-border)] px-5 py-3 text-sm font-semibold text-[var(--color-ink)] transition hover:bg-[var(--color-card-muted)]"
              >
                Restore barcode
              </button>
            ) : (
              <button
                type="submit"
                formAction={softDeleteAdminBarcodeProductAction}
                className="rounded-2xl border border-[var(--color-danger)]/30 px-5 py-3 text-sm font-semibold text-[var(--color-danger)] transition hover:bg-[var(--color-danger)]/10"
              >
                Soft delete barcode
              </button>
            )}
          </div>
        </form>
      </AdminSection>

      <div className="grid gap-6 xl:grid-cols-[0.8fr_1.2fr]">
        <AdminSection title="Metadata">
          <div className="space-y-3 text-sm text-[var(--color-muted)]">
            <p>Submitter: {barcode.addedByEmail ?? "Unknown"}</p>
            <p>Created: {formatAdminTimestamp(barcode.createdAt)}</p>
            <p>Updated: {formatAdminTimestamp(barcode.updatedAt)}</p>
            <p>
              Deleted: {barcode.deletedAt ? formatAdminTimestamp(barcode.deletedAt) : "No"}
            </p>
            {barcode.deletedByEmail ? <p>Deleted by: {barcode.deletedByEmail}</p> : null}
          </div>
        </AdminSection>

        <AdminSection title="Audit History">
          {audit.items.length === 0 ? (
            <AdminNotice>No audit events recorded for this barcode yet.</AdminNotice>
          ) : (
            <div className="space-y-3">
              {audit.items.map((event) => (
                <div
                  key={event.id}
                  className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="font-semibold text-[var(--color-ink)]">{event.action}</p>
                      <p className="mt-1 text-sm text-[var(--color-muted)]">
                        {event.actorEmail ?? "Unknown user"}
                      </p>
                    </div>
                    <span className="text-xs text-[var(--color-muted)]">
                      {formatAdminTimestamp(event.createdAt)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </AdminSection>
      </div>
    </div>
  );
}
