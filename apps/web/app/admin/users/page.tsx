import Link from "next/link";

import { listAdminUsers } from "@macro-tracker/db";

import {
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
  const q = params.q ?? "";
  const result = await listAdminUsers({
    q,
    role: role === "user" || role === "admin" || role === "owner" ? role : "all",
    activity:
      activity === "active7" || activity === "inactive7" ? activity : "all",
    page: Number.isFinite(page) ? page : 1,
  });

  return (
    <div className="space-y-6">
      <AdminSection
        title="Users"
        description="Inspect accounts, login activity, and role assignments."
      >
        <form className="grid gap-3 md:grid-cols-[1.8fr_0.8fr_0.8fr_auto]">
          <input
            type="search"
            name="q"
            placeholder="Search email or display name"
            defaultValue={q}
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
          />
          <select
            name="role"
            defaultValue={role}
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
          >
            <option value="all">All roles</option>
            <option value="user">Users</option>
            <option value="admin">Admins</option>
            <option value="owner">Owners</option>
          </select>
          <select
            name="activity"
            defaultValue={activity}
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
          >
            <option value="all">All activity</option>
            <option value="active7">Active in 7 days</option>
            <option value="inactive7">Inactive in 7 days</option>
          </select>
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
          }}
          pagination={result.pagination}
        />
      </AdminSection>
    </div>
  );
}
