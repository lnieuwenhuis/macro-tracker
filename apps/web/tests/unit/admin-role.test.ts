import { describe, expect, it } from "vitest";

import { canAccessAdmin, isOwnerRole, type AdminRole } from "@macro-tracker/db";

// Exercises the real canAccessAdmin/isOwnerRole, unlike admin-auth.test.ts's mocked reimplementation.
describe("canAccessAdmin", () => {
  it("grants admin role access", () => {
    expect(canAccessAdmin("admin")).toBe(true);
  });

  it("grants owner role access", () => {
    expect(canAccessAdmin("owner")).toBe(true);
  });

  it("denies the plain user role", () => {
    expect(canAccessAdmin("user")).toBe(false);
  });

  it("denies unknown roles that bypass the type system", () => {
    expect(canAccessAdmin("superadmin" as AdminRole)).toBe(false);
  });

  it("denies an empty-string role", () => {
    expect(canAccessAdmin("" as AdminRole)).toBe(false);
  });
});

describe("isOwnerRole", () => {
  it("recognizes only the owner role", () => {
    expect(isOwnerRole("owner")).toBe(true);
  });

  it("denies the admin role", () => {
    expect(isOwnerRole("admin")).toBe(false);
  });

  it("denies the plain user role", () => {
    expect(isOwnerRole("user")).toBe(false);
  });

  it("denies unknown roles that bypass the type system", () => {
    expect(isOwnerRole("superowner" as AdminRole)).toBe(false);
  });

  it("denies an empty-string role", () => {
    expect(isOwnerRole("" as AdminRole)).toBe(false);
  });
});
