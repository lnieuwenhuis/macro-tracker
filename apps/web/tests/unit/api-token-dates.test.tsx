/** @vitest-environment jsdom */
// UI-11: token timestamps must render identically on the server regardless of
// the viewer's zone (no hydration mismatch), then enhance to local time.
import type { ApiTokenRecord } from "@macro-tracker/db";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  requireOnboardedSessionUser: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireOnboardedSessionUser: mocked.requireOnboardedSessionUser,
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocked.revalidatePath,
}));

import {
  ApiSettingsClient,
  formatStableTokenDate,
} from "@/components/api-settings-client";

const originalTz = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTz;
});

function token(): ApiTokenRecord {
  return {
    id: "token-1",
    name: "Shortcut",
    tokenPrefix: "mtk_v1_abc",
    scopes: ["read:daily"],
    createdAt: "2026-01-15T10:00:00.000Z",
    lastUsedAt: null,
    expiresAt: "2026-04-15T10:00:00.000Z",
    revokedAt: null,
  } as unknown as ApiTokenRecord;
}

describe("UI-11 stable token timestamps", () => {
  it("formats the stable initial render identically in UTC and Europe/Amsterdam", () => {
    process.env.TZ = "UTC";
    const utcRender = formatStableTokenDate("2026-01-15T10:00:00.000Z");

    process.env.TZ = "Europe/Amsterdam";
    const amsterdamRender = formatStableTokenDate("2026-01-15T10:00:00.000Z");

    expect(amsterdamRender).toBe(utcRender);
    expect(utcRender).toContain("10:00");
    expect(utcRender).toContain("UTC");
    expect(formatStableTokenDate(null)).toBe("Never");
  });

  it("renders created/used/expiry timestamps and enhances to local time after hydration", async () => {
    process.env.TZ = "Europe/Amsterdam";
    const { container } = render(<ApiSettingsClient tokens={[token()]} scopes={[]} />);

    // Post-hydration enhancement: the viewer's own zone with its abbreviation.
    const local = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date("2026-01-15T10:00:00.000Z"));
    expect(await screen.findByText("Tokens")).toBeTruthy();
    expect(container.textContent).toContain(`Created ${local}`);
    expect(container.textContent).toContain("Last used Never");
  });
});
