/** @vitest-environment jsdom */
// UI-27: flat admin navigation marks exactly one item active (longest match)
// with current-page semantics.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  pathname: "/admin",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocked.pathname,
}));

import { AdminShell, getActiveAdminHref } from "@/components/admin-shell";

const links = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/barcodes", label: "Barcodes" },
  { href: "/admin/barcodes/review", label: "Review Queue" },
  { href: "/admin/ai-benchmark", label: "AI Benchmark" },
];

describe("UI-27 admin navigation", () => {
  it("picks the most specific matching item", () => {
    expect(getActiveAdminHref("/admin", links)).toBe("/admin");
    expect(getActiveAdminHref("/admin/users", links)).toBe("/admin/users");
    expect(getActiveAdminHref("/admin/barcodes", links)).toBe("/admin/barcodes");
    // The reported defect: both Barcodes and Review Queue were active here.
    expect(getActiveAdminHref("/admin/barcodes/review", links)).toBe(
      "/admin/barcodes/review",
    );
    expect(
      getActiveAdminHref("/admin/barcodes/123e4567-e89b-12d3-a456-426614174000", links),
    ).toBe("/admin/barcodes");
    expect(getActiveAdminHref("/admin/ai-benchmark", links)).toBe(
      "/admin/ai-benchmark",
    );
  });

  it("exposes exactly one current page on the review route", () => {
    mocked.pathname = "/admin/barcodes/review";
    render(
      <AdminShell userEmail="owner@example.com" role="owner">
        <div>content</div>
      </AdminShell>,
    );

    const current = screen.getAllByRole("link", { current: "page" });
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe("Review Queue");
  });

  it("keeps barcodes active on a barcode detail route", () => {
    mocked.pathname = "/admin/barcodes/123e4567-e89b-12d3-a456-426614174000";
    render(
      <AdminShell userEmail="owner@example.com" role="owner">
        <div>content</div>
      </AdminShell>,
    );

    const current = screen.getAllByRole("link", { current: "page" });
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe("Barcodes");
  });
});
