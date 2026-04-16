import Link from "next/link";

import { listAdminBarcodeProducts } from "@macro-tracker/db";

import {
  AdminNotice,
  AdminPaginationLinks,
  AdminSection,
  formatAdminTimestamp,
} from "@/components/admin-ui";
import { createAdminBarcodeProductAction } from "@/lib/admin-actions";

type AdminBarcodesPageProps = {
  searchParams: Promise<{
    q?: string;
    status?: string;
    submitter?: string;
    page?: string;
    error?: string;
  }>;
};

function BarcodeField({
  label,
  name,
  type = "text",
  step,
  required = false,
}: {
  label: string;
  name: string;
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
        step={step}
        required={required}
        className="w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
      />
    </label>
  );
}

export default async function AdminBarcodesPage({
  searchParams,
}: AdminBarcodesPageProps) {
  const params = await searchParams;
  const page = Number(params.page ?? "1");
  const q = params.q ?? "";
  const status = params.status ?? "all";
  const submitter = params.submitter ?? "";
  const result = await listAdminBarcodeProducts({
    q,
    status: status === "active" || status === "deleted" ? status : "all",
    submitter,
    page: Number.isFinite(page) ? page : 1,
  });

  return (
    <div className="space-y-6">
      {params.error ? <AdminNotice tone="error">{params.error}</AdminNotice> : null}

      <AdminSection
        title="Create Barcode Record"
        description="Add a shared catalogue item directly from the admin panel."
      >
        <form
          action={createAdminBarcodeProductAction}
          className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"
        >
          <BarcodeField label="Barcode" name="barcode" required />
          <BarcodeField label="Name" name="name" required />
          <BarcodeField label="Brand" name="brands" />
          <BarcodeField label="Serving size (g)" name="servingSizeG" type="number" step="0.1" />
          <BarcodeField label="Protein (g)" name="proteinG" type="number" step="0.1" required />
          <BarcodeField label="Carbs (g)" name="carbsG" type="number" step="0.1" required />
          <BarcodeField label="Fat (g)" name="fatG" type="number" step="0.1" required />
          <BarcodeField label="Calories" name="caloriesKcal" type="number" step="1" required />
          <div className="md:col-span-2 xl:col-span-4">
            <button
              type="submit"
              className="rounded-2xl bg-[var(--color-accent)] px-5 py-3 text-sm font-semibold text-white transition hover:opacity-90"
            >
              Create barcode
            </button>
          </div>
        </form>
      </AdminSection>

      <AdminSection
        title="Barcode Catalogue"
        description="Search, filter, and inspect all shared barcode records."
      >
        <form className="grid gap-3 md:grid-cols-[1.6fr_0.8fr_1fr_auto]">
          <input
            type="search"
            name="q"
            placeholder="Search barcode, name, or brand"
            defaultValue={q}
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
          />
          <select
            name="status"
            defaultValue={status}
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="deleted">Deleted</option>
          </select>
          <input
            type="search"
            name="submitter"
            placeholder="Filter by submitter email"
            defaultValue={submitter}
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
          />
          <button
            type="submit"
            className="rounded-2xl bg-[var(--color-accent)] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90"
          >
            Apply
          </button>
        </form>

        <div className="mt-5 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
              <tr>
                <th className="pb-3 pr-4">Product</th>
                <th className="pb-3 pr-4">Barcode</th>
                <th className="pb-3 pr-4">Submitter</th>
                <th className="pb-3 pr-4">Status</th>
                <th className="pb-3">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {result.items.map((item) => (
                <tr key={item.id}>
                  <td className="py-3 pr-4">
                    <Link
                      href={`/admin/barcodes/${item.id}`}
                      className="font-semibold text-[var(--color-ink)] underline-offset-4 hover:underline"
                    >
                      {item.name}
                    </Link>
                    {item.brands ? (
                      <p className="mt-1 text-xs text-[var(--color-muted)]">{item.brands}</p>
                    ) : null}
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
                    {formatAdminTimestamp(item.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <AdminPaginationLinks
          pathname="/admin/barcodes"
          searchParams={{
            q: q || undefined,
            status: status !== "all" ? status : undefined,
            submitter: submitter || undefined,
          }}
          pagination={result.pagination}
        />
      </AdminSection>
    </div>
  );
}
