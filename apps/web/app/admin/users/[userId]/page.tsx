import Link from "next/link";
import { notFound } from "next/navigation";

import { getAdminUserDetail, isOwnerRole } from "@macro-tracker/db";

import {
  AdminNotice,
  AdminRoleBadge,
  AdminSection,
  AdminStatCard,
  formatAdminTimestamp,
} from "@/components/admin-ui";
import { changeUserRoleAction } from "@/lib/admin-actions";
import { requireAdminUser } from "@/lib/auth";

type AdminUserDetailPageProps = {
  params: Promise<{ userId: string }>;
  searchParams: Promise<{
    saved?: string;
    error?: string;
  }>;
};

function GoalValue({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
        {label}
      </p>
      <p className="mt-2 text-lg font-semibold text-[var(--color-ink)]">{value}</p>
    </div>
  );
}

export default async function AdminUserDetailPage({
  params,
  searchParams,
}: AdminUserDetailPageProps) {
  const adminUser = await requireAdminUser();
  const [{ userId }, query] = await Promise.all([params, searchParams]);
  const detail = await getAdminUserDetail(userId);

  if (!detail) {
    notFound();
  }

  return (
    <div className="space-y-6">
      {query.saved === "role" ? (
        <AdminNotice tone="success">Role updated.</AdminNotice>
      ) : null}
      {query.error ? <AdminNotice tone="error">{query.error}</AdminNotice> : null}

      <AdminSection
        title={detail.user.displayName ?? detail.user.email}
        description="Read-only account overview with role controls for owners."
        action={<AdminRoleBadge role={detail.user.role} />}
      >
        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-4">
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] p-4">
              <p className="text-sm text-[var(--color-muted)]">{detail.user.email}</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <GoalValue
                  label="Created"
                  value={formatAdminTimestamp(detail.user.createdAt)}
                />
                <GoalValue
                  label="Last Login"
                  value={formatAdminTimestamp(detail.user.lastLoginAt)}
                />
                <GoalValue
                  label="Goal Calories"
                  value={
                    detail.goals.caloriesKcal != null
                      ? `${detail.goals.caloriesKcal} kcal`
                      : "Not set"
                  }
                />
                <GoalValue
                  label="Goal Weight"
                  value={
                    detail.user.goalWeightKg != null
                      ? `${detail.user.goalWeightKg} kg`
                      : "Not set"
                  }
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
              <AdminStatCard label="Meals" value={String(detail.counts.mealEntries)} />
              <AdminStatCard label="Weights" value={String(detail.counts.weightEntries)} />
              <AdminStatCard label="Recipes" value={String(detail.counts.recipes)} />
              <AdminStatCard label="Presets" value={String(detail.counts.presets)} />
              <AdminStatCard
                label="Barcodes"
                value={String(detail.counts.barcodeSubmissions)}
              />
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] p-4">
              <h3 className="text-sm font-bold text-[var(--color-ink)]">Macro goals</h3>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <GoalValue
                  label="Protein"
                  value={
                    detail.goals.proteinG != null ? `${detail.goals.proteinG} g` : "Not set"
                  }
                />
                <GoalValue
                  label="Carbs"
                  value={
                    detail.goals.carbsG != null ? `${detail.goals.carbsG} g` : "Not set"
                  }
                />
                <GoalValue
                  label="Fat"
                  value={
                    detail.goals.fatG != null ? `${detail.goals.fatG} g` : "Not set"
                  }
                />
              </div>
            </div>

            {isOwnerRole(adminUser.role) ? (
              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] p-4">
                <h3 className="text-sm font-bold text-[var(--color-ink)]">Role access</h3>
                <form action={changeUserRoleAction} className="mt-4 flex flex-col gap-3 sm:flex-row">
                  <input type="hidden" name="userId" value={detail.user.id} />
                  <select
                    name="role"
                    defaultValue={detail.user.role}
                    className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-4 py-3 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                    <option value="owner">Owner</option>
                  </select>
                  <button
                    type="submit"
                    className="rounded-2xl bg-[var(--color-accent)] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90"
                  >
                    Update role
                  </button>
                </form>
              </div>
            ) : null}
          </div>
        </div>
      </AdminSection>

      <div className="grid gap-6 xl:grid-cols-2">
        <AdminSection title="Recent Meals">
          <div className="space-y-3">
            {detail.recentMeals.map((meal) => (
              <div
                key={meal.id}
                className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="font-semibold text-[var(--color-ink)]">{meal.label}</p>
                  <span className="text-xs text-[var(--color-muted)]">{meal.date}</span>
                </div>
                <p className="mt-1 text-sm text-[var(--color-muted)]">
                  {meal.proteinG}P / {meal.carbsG}C / {meal.fatG}F / {meal.caloriesKcal} kcal
                </p>
              </div>
            ))}
          </div>
        </AdminSection>

        <AdminSection title="Recent Weight Entries">
          <div className="space-y-3">
            {detail.recentWeights.map((entry) => (
              <div
                key={entry.id}
                className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="font-semibold text-[var(--color-ink)]">{entry.weightKg} kg</p>
                  <span className="text-xs text-[var(--color-muted)]">{entry.date}</span>
                </div>
                <p className="mt-1 text-sm text-[var(--color-muted)]">
                  Body fat: {entry.bodyFatPct != null ? `${entry.bodyFatPct}%` : "n/a"}
                </p>
              </div>
            ))}
          </div>
        </AdminSection>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <AdminSection title="Recent Recipes">
          <div className="space-y-3">
            {detail.recentRecipes.map((recipe) => (
              <div
                key={recipe.id}
                className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3"
              >
                <p className="font-semibold text-[var(--color-ink)]">{recipe.label}</p>
                <p className="mt-1 text-sm text-[var(--color-muted)]">
                  {recipe.portions} portions, updated {formatAdminTimestamp(recipe.updatedAt)}
                </p>
              </div>
            ))}
          </div>
        </AdminSection>

        <AdminSection title="Recent Presets">
          <div className="space-y-3">
            {detail.recentPresets.map((preset) => (
              <div
                key={preset.id}
                className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3"
              >
                <p className="font-semibold text-[var(--color-ink)]">{preset.label}</p>
                <p className="mt-1 text-sm text-[var(--color-muted)]">
                  {preset.proteinG}P / {preset.carbsG}C / {preset.fatG}F / {preset.caloriesKcal} kcal
                </p>
              </div>
            ))}
          </div>
        </AdminSection>
      </div>

      <AdminSection title="Barcode Submissions">
        <div className="space-y-3">
          {detail.recentBarcodeSubmissions.map((item) => (
            <div
              key={item.id}
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3"
            >
              <div className="flex items-center justify-between gap-3">
                <Link
                  href={`/admin/barcodes/${item.id}`}
                  className="font-semibold text-[var(--color-ink)] underline-offset-4 hover:underline"
                >
                  {item.name}
                </Link>
                <span className="rounded-full bg-[var(--color-card-muted)] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-strong)]">
                  {item.status}
                </span>
              </div>
              <p className="mt-1 font-mono text-xs text-[var(--color-muted)]">{item.barcode}</p>
            </div>
          ))}
        </div>
      </AdminSection>
    </div>
  );
}
