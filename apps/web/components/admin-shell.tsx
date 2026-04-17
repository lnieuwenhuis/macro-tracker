"use client";

import type { AdminRole } from "@macro-tracker/db";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

type AdminShellProps = {
  userEmail: string;
  role: AdminRole;
  children: ReactNode;
};

function getRoleLabel(role: AdminRole) {
  return role === "owner" ? "Owner" : role === "admin" ? "Admin" : "User";
}

export function AdminShell({ userEmail, role, children }: AdminShellProps) {
  const pathname = usePathname();
  const links = [
    { href: "/admin", label: "Dashboard" },
    { href: "/admin/users", label: "Users" },
    { href: "/admin/barcodes", label: "Barcodes" },
    ...(role === "owner" ? [{ href: "/admin/audit", label: "Audit" }] : []),
  ];

  return (
    <main className="min-h-screen bg-[var(--color-app-bg)] text-[var(--color-ink)]">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 pb-8 pt-[calc(1rem+env(safe-area-inset-top))] sm:px-6">
        <header className="rounded-[2rem] border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-5 py-5 shadow-[0_18px_50px_rgba(0,0,0,0.08)]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--color-muted-strong)]">
                Macro Tracker Admin
              </p>
              <h1 className="mt-2 font-serif text-3xl text-[var(--color-ink)]">
                Operations Panel
              </h1>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/"
                className="rounded-full border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] transition hover:bg-[var(--color-card-muted)]"
              >
                Back to app
              </Link>
              <span className="rounded-full bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-white">
                {getRoleLabel(role)}
              </span>
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <nav className="flex flex-wrap gap-2">
              {links.map((link) => {
                const active =
                  pathname === link.href || pathname.startsWith(`${link.href}/`);

                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                      active
                        ? "bg-[var(--color-accent)] text-white"
                        : "border border-[var(--color-border)] text-[var(--color-ink)] hover:bg-[var(--color-card-muted)]"
                    }`}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </nav>

            <div className="flex items-center gap-3">
              <p className="max-w-[16rem] truncate text-sm text-[var(--color-muted)]">
                {userEmail}
              </p>
              <form action="/api/auth/logout" method="post">
                <button
                  type="submit"
                  className="rounded-full border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-muted-strong)] transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
                >
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </header>

        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}
