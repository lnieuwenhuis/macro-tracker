import { listAdminBarcodeProducts } from "@macro-tracker/db";

import { AdminFormField } from "@/components/admin-form-field";
import {
  AdminBarcodeProductRow,
  AdminFilterInput,
  AdminFilterSelect,
  AdminFilterSubmitButton,
  AdminNotice,
  AdminPaginationLinks,
  AdminSection,
} from "@/components/admin-ui";
import { createAdminBarcodeProductAction } from "@/lib/admin-actions";
import { requireAdminUser } from "@/lib/auth";

type AdminBarcodesPageProps = {
  searchParams: Promise<{
    q?: string;
    status?: string;
    submitter?: string;
    page?: string;
    error?: string;
  }>;
};

export default async function AdminBarcodesPage({
  searchParams,
}: AdminBarcodesPageProps) {
  const adminUser = await requireAdminUser();
  const params = await searchParams;
  const page = Number(params.page ?? "1");
  const q = params.q ?? "";
  const status = params.status ?? "all";
  const submitter = params.submitter ?? "";
  const result = await listAdminBarcodeProducts(adminUser.id, {
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
          <AdminFormField label="Barcode" name="barcode" required />
          <AdminFormField label="Name" name="name" required />
          <AdminFormField label="Brand" name="brands" />
          <AdminFormField label="Serving size (g)" name="servingSizeG" type="number" step="0.1" />
          <AdminFormField label="Protein (g)" name="proteinG" type="number" step="0.1" required />
          <AdminFormField label="Carbs (g)" name="carbsG" type="number" step="0.1" required />
          <AdminFormField label="Fat (g)" name="fatG" type="number" step="0.1" required />
          <AdminFormField label="Calories" name="caloriesKcal" type="number" step="1" required />
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
          <AdminFilterInput
            type="search"
            name="q"
            placeholder="Search barcode, name, or brand"
            defaultValue={q}
          />
          <AdminFilterSelect
            name="status"
            defaultValue={status}
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="deleted">Deleted</option>
          </AdminFilterSelect>
          <AdminFilterInput
            type="search"
            name="submitter"
            placeholder="Filter by submitter email"
            defaultValue={submitter}
          />
          <AdminFilterSubmitButton />
        </form>

        <div className="mt-5 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
              <tr>
                <th className="pb-3 pr-4">Product</th>
                <th className="pb-3 pr-4">Barcode</th>
                <th className="pb-3 pr-4">Source</th>
                <th className="pb-3 pr-4">Status</th>
                <th className="pb-3">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {result.items.map((item) => (
                <AdminBarcodeProductRow
                  key={item.id}
                  product={item}
                  detail="full"
                  timestamp="updated"
                />
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
