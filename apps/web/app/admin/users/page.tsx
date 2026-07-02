import Link from "next/link";

import { listAdminUsers } from "@macro-tracker/db";

import {
  AdminFilterInput,
  AdminFilterSelect,
  AdminFilterSubmitButton,
  AdminPaginationLinks,
  AdminRoleBadge,
  AdminSection,
  formatAdminTimestamp,
} from "@/components/admin-ui";

type AdminUsersPageProps = {
  searchParams: Promise<{
    q?: string;
    role?: string;
    activity?: string;
    health?: string;
    page?: string;
  }>;
};

export default async function AdminUsersPage({
  searchParams,
}: AdminUsersPageProps) {
  const params = await searchParams;
  const page = Number(params.page ?? "1");
  const role = params.role ?? "all";
  const activity = params.activity ?? "all";
  const health = params.health ?? "all";
  const q = params.q ?? "";
  const result = await listAdminUsers({
    q,
    role: role === "user" || role === "admin" || role === "owner" ? role : "all",
    activity:
      activity === "active7" ||
      activity === "inactive7" ||
      activity === "inactive30"
        ? activity
        : "all",
    health:
      health === "onboarded_no_logs" ||
      health === "no_goals" ||
      health === "no_weight_entries" ||
      health === "heavy_barcode_submitters"
        ? health
        : "all",
    page: Number.isFinite(page) ? page : 1,
  });

  return (
    <div className="space-y-6">
      <AdminSection
        title="Users"
        description="Inspect accounts, login activity, and role assignments."
      >
        <form className="grid gap-3 md:grid-cols-[1.5fr_0.7fr_0.8fr_1fr_auto]">
          <AdminFilterInput
            type="search"
            name="q"
            placeholder="Search email or display name"
            defaultValue={q}
          />
          <AdminFilterSelect
            name="role"
            defaultValue={role}
          >
            <option value="all">All roles</option>
            <option value="user">Users</option>
            <option value="admin">Admins</option>
            <option value="owner">Owners</option>
          </AdminFilterSelect>
          <AdminFilterSelect
            name="activity"
            defaultValue={activity}
          >
            <option value="all">All activity</option>
            <option value="active7">Active in 7 days</option>
            <option value="inactive7">Inactive in 7 days</option>
            <option value="inactive30">Inactive in 30 days</option>
          </AdminFilterSelect>
          <AdminFilterSelect
            name="health"
            defaultValue={health}
          >
            <option value="all">All health signals</option>
            <option value="onboarded_no_logs">Onboarded, no logs</option>
            <option value="no_goals">No goals set</option>
            <option value="no_weight_entries">No weight entries</option>
            <option value="heavy_barcode_submitters">Heavy barcode submitters</option>
          </AdminFilterSelect>
          <AdminFilterSubmitButton />
        </form>

        <div className="mt-5 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
              <tr>
                <th className="pb-3 pr-4">User</th>
                <th className="pb-3 pr-4">Role</th>
                <th className="pb-3 pr-4">Created</th>
                <th className="pb-3">Last login</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {result.items.map((user) => (
                <tr key={user.id}>
                  <td className="py-3 pr-4">
                    <Link
                      href={`/admin/users/${user.id}`}
                      className="font-semibold text-[var(--color-ink)] underline-offset-4 hover:underline"
                    >
                      {user.email}
                    </Link>
                    {user.displayName ? (
                      <p className="mt-1 text-xs text-[var(--color-muted)]">
                        {user.displayName}
                      </p>
                    ) : null}
                  </td>
                  <td className="py-3 pr-4">
                    <AdminRoleBadge role={user.role} />
                  </td>
                  <td className="py-3 pr-4 text-[var(--color-muted)]">
                    {formatAdminTimestamp(user.createdAt)}
                  </td>
                  <td className="py-3 text-[var(--color-muted)]">
                    {formatAdminTimestamp(user.lastLoginAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <AdminPaginationLinks
          pathname="/admin/users"
          searchParams={{
            q: q || undefined,
            role: role !== "all" ? role : undefined,
            activity: activity !== "all" ? activity : undefined,
            health: health !== "all" ? health : undefined,
          }}
          pagination={result.pagination}
        />
      </AdminSection>
    </div>
  );
}
