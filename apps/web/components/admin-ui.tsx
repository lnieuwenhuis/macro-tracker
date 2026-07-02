import type {
  AdminAuditEvent,
  AdminPagination,
  AdminRole,
  FoodProduct,
} from "@macro-tracker/db";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

const ADMIN_FILTER_CONTROL_CLASS =
  "rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]";
const ADMIN_FILTER_BUTTON_CLASS =
  "rounded-2xl bg-[var(--color-accent)] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90";

function roleStyles(role: AdminRole) {
  if (role === "owner") {
    return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
  }

  if (role === "admin") {
    return "bg-sky-500/15 text-sky-700 dark:text-sky-300";
  }

  return "bg-[var(--color-card-muted)] text-[var(--color-muted-strong)]";
}

export function formatAdminTimestamp(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function AdminRoleBadge({ role }: { role: AdminRole }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] ${roleStyles(role)}`}
    >
      {role}
    </span>
  );
}

export function AdminNotice({
  tone = "info",
  children,
}: {
  tone?: "info" | "success" | "error";
  children: ReactNode;
}) {
  const toneClass =
    tone === "success"
      ? "border-[var(--color-success)]/30 bg-[var(--color-success)]/10 text-[var(--color-success)]"
      : tone === "error"
        ? "border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 text-[var(--color-danger)]"
        : "border-[var(--color-border)] bg-[var(--color-surface-strong)] text-[var(--color-muted-strong)]";

  return (
    <div className={`rounded-2xl border px-4 py-3 text-sm ${toneClass}`}>
      {children}
    </div>
  );
}

export function AdminStatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-4 shadow-[0_10px_24px_rgba(0,0,0,0.04)]">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted-strong)]">
        {label}
      </p>
      <p className="mt-2 text-3xl font-bold text-[var(--color-ink)]">{value}</p>
      {sub ? <p className="mt-1 text-sm text-[var(--color-muted)]">{sub}</p> : null}
    </div>
  );
}

export function AdminSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[2rem] border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5 shadow-[0_12px_30px_rgba(0,0,0,0.05)] sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-bold text-[var(--color-ink)]">{title}</h2>
          {description ? (
            <p className="mt-1 text-sm text-[var(--color-muted)]">{description}</p>
          ) : null}
        </div>
        {action ? <div>{action}</div> : null}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

export function AdminAuditEventCard({
  event,
  layout = "compact",
}: {
  event: AdminAuditEvent;
  layout?: "compact" | "wide";
}) {
  const contentClass =
    layout === "wide"
      ? "flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"
      : "flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between";

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3">
      <div className={contentClass}>
        <div>
          <Link
            href={`/admin/audit/${event.id}`}
            className="font-semibold text-[var(--color-ink)] underline-offset-4 hover:underline"
          >
            {event.action}
          </Link>
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
  );
}

export function AdminBarcodeProductRow({
  product,
  detail = "compact",
  timestamp = "created",
}: {
  product: FoodProduct;
  detail?: "compact" | "full";
  timestamp?: "created" | "updated";
}) {
  const timestampValue =
    timestamp === "updated" ? product.updatedAt : product.createdAt;

  return (
    <tr>
      <td className="py-3 pr-4">
        <Link
          href={`/admin/barcodes/${product.id}`}
          className="font-semibold text-[var(--color-ink)] underline-offset-4 hover:underline"
        >
          {product.name}
        </Link>
        {detail === "full" && product.brand ? (
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            {product.brand}
          </p>
        ) : null}
      </td>
      <td className="py-3 pr-4 font-mono text-xs text-[var(--color-muted)]">
        {product.barcode}
      </td>
      <td className="py-3 pr-4 text-[var(--color-muted)]">
        <span>{product.sourceProvider ?? product.source}</span>
        {detail === "full" && product.sourceConfidence != null ? (
          <span className="ml-1 text-xs">
            ({Math.round(product.sourceConfidence * 100)}%)
          </span>
        ) : null}
        {detail === "full" && product.submittedByUserId ? (
          <p className="mt-1 font-mono text-[10px]">
            {product.submittedByUserId}
          </p>
        ) : null}
      </td>
      <td className="py-3 pr-4">
        <span className="rounded-full bg-[var(--color-card-muted)] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-strong)]">
          {product.deletedAt ? "deleted" : "active"}
        </span>
      </td>
      <td className="py-3 text-[var(--color-muted)]">
        {formatAdminTimestamp(timestampValue)}
      </td>
    </tr>
  );
}

export function AdminFilterInput({ className = "", ...props }: ComponentProps<"input">) {
  return (
    <input
      {...props}
      className={`${ADMIN_FILTER_CONTROL_CLASS}${className ? ` ${className}` : ""}`}
    />
  );
}

export function AdminFilterSelect({ className = "", ...props }: ComponentProps<"select">) {
  return (
    <select
      {...props}
      className={`${ADMIN_FILTER_CONTROL_CLASS}${className ? ` ${className}` : ""}`}
    />
  );
}

export function AdminFilterSubmitButton({
  className = "",
  children = "Apply",
  ...props
}: ComponentProps<"button">) {
  return (
    <button
      {...props}
      type={props.type ?? "submit"}
      className={`${ADMIN_FILTER_BUTTON_CLASS}${className ? ` ${className}` : ""}`}
    >
      {children}
    </button>
  );
}

export function AdminPaginationLinks({
  pathname,
  searchParams,
  pagination,
}: {
  pathname: string;
  searchParams: Record<string, string | undefined>;
  pagination: AdminPagination;
}) {
  if (pagination.totalPages <= 1) {
    return null;
  }

  const buildHref = (page: number) => {
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(searchParams)) {
      if (value) {
        params.set(key, value);
      }
    }

    params.set("page", String(page));
    return `${pathname}?${params.toString()}`;
  };

  return (
    <div className="mt-5 flex items-center justify-between text-sm">
      <Link
        href={buildHref(Math.max(1, pagination.page - 1))}
        className={`rounded-full border px-4 py-2 font-semibold ${
          pagination.page <= 1
            ? "pointer-events-none border-[var(--color-border)] text-[var(--color-muted)] opacity-50"
            : "border-[var(--color-border)] text-[var(--color-ink)] hover:bg-[var(--color-card-muted)]"
        }`}
      >
        Previous
      </Link>
      <p className="text-[var(--color-muted)]">
        Page {pagination.page} of {pagination.totalPages}
      </p>
      <Link
        href={buildHref(Math.min(pagination.totalPages, pagination.page + 1))}
        className={`rounded-full border px-4 py-2 font-semibold ${
          pagination.page >= pagination.totalPages
            ? "pointer-events-none border-[var(--color-border)] text-[var(--color-muted)] opacity-50"
            : "border-[var(--color-border)] text-[var(--color-ink)] hover:bg-[var(--color-card-muted)]"
        }`}
      >
        Next
      </Link>
    </div>
  );
}
