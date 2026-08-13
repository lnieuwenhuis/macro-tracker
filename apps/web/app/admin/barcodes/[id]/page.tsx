import { notFound } from "next/navigation";

import { getAdminBarcodeProductById, listAdminAuditEvents } from "@macro-tracker/db";

import { AdminFormField } from "@/components/admin-form-field";
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
import { requireAdminUser } from "@/lib/auth";

type AdminBarcodeDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    saved?: string;
    error?: string;
  }>;
};

export default async function AdminBarcodeDetailPage({
  params,
  searchParams,
}: AdminBarcodeDetailPageProps) {
  const adminUser = await requireAdminUser();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const [barcode, audit] = await Promise.all([
    getAdminBarcodeProductById(adminUser.id, id),
    listAdminAuditEvents(adminUser.id, {
      targetType: "food_product",
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
        description={`${barcode.barcode ?? "No barcode"} • ${barcode.deletedAt ? "deleted" : "active"}`}
      >
        <form action={updateAdminBarcodeProductAction} className="grid gap-4 lg:grid-cols-2">
          <input type="hidden" name="id" value={barcode.id} />
          <AdminFormField label="Barcode" name="barcode" defaultValue={barcode.barcode ?? ""} required />
          <AdminFormField label="Name" name="name" defaultValue={barcode.name} required />
          <AdminFormField label="Brand" name="brands" defaultValue={barcode.brand} />
          <AdminFormField
            label="Serving size (g)"
            name="servingSizeG"
            defaultValue={barcode.servingWeightG ?? ""}
            type="number"
            step="0.1"
          />
          <AdminFormField
            label="Protein (g)"
            name="proteinG"
            defaultValue={barcode.proteinPer100}
            type="number"
            step="0.1"
            required
          />
          <AdminFormField
            label="Carbs (g)"
            name="carbsG"
            defaultValue={barcode.carbsPer100}
            type="number"
            step="0.1"
            required
          />
          <AdminFormField
            label="Fat (g)"
            name="fatG"
            defaultValue={barcode.fatPer100}
            type="number"
            step="0.1"
            required
          />
          <AdminFormField
            label="Calories"
            name="caloriesKcal"
            defaultValue={barcode.caloriesPer100}
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
            <p>Source: {barcode.sourceProvider ?? barcode.source}</p>
            {barcode.sourceConfidence != null ? (
              <p>Confidence: {Math.round(barcode.sourceConfidence * 100)}%</p>
            ) : null}
            <p>Submitter ID: {barcode.submittedByUserId ?? "Unknown"}</p>
            <p>Created: {formatAdminTimestamp(barcode.createdAt)}</p>
            <p>Updated: {formatAdminTimestamp(barcode.updatedAt)}</p>
            <p>
              Deleted: {barcode.deletedAt ? formatAdminTimestamp(barcode.deletedAt) : "No"}
            </p>
            {barcode.deletedByUserId ? <p>Deleted by ID: {barcode.deletedByUserId}</p> : null}
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
