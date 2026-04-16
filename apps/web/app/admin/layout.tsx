import type { Metadata } from "next";

import { AdminShell } from "@/components/admin-shell";
import { requireAdminUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Admin | Macro Tracker",
};

export default async function AdminLayout({
  children,
}: LayoutProps<"/admin">) {
  const adminUser = await requireAdminUser();

  return (
    <AdminShell userEmail={adminUser.email} role={adminUser.role}>
      {children}
    </AdminShell>
  );
}
