/**
 * iOS Safari zooms in on any focused form control rendering text below 16px
 * and never zooms back out. This scans source rather than rendered output,
 * since the defect is a class on a control and only shows on a real device.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const WEB_ROOT = join(__dirname, "..", "..");
const SCANNED_DIRS = ["components", "app"];

// Controls with no text of their own; iOS has nothing to zoom for them.
const ZOOM_EXEMPT_TYPES = ["checkbox", "radio", "hidden", "file"];

// The one size the coarse-pointer rebase in globals.css covers.
const REBASED_SIZE = "text-sm";

function collectTsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return collectTsxFiles(full);
    return entry.name.endsWith(".tsx") ? [full] : [];
  });
}

type Control = { file: string; line: number; sizes: string[] };

function collectFormControls(): Control[] {
  const controls: Control[] = [];

  for (const dir of SCANNED_DIRS) {
    for (const file of collectTsxFiles(join(WEB_ROOT, dir))) {
      // Arrow functions inside JSX props would otherwise end the tag early.
      const source = readFileSync(file, "utf8").split("=>").join("=@");
      const tag = /<(input|textarea|select)(\s[^>]*?)?(\/>|>)/g;

      for (let match = tag.exec(source); match; match = tag.exec(source)) {
        const attributes = match[2] ?? "";
        const type = /type="([a-z]+)"/.exec(attributes)?.[1];
        if (type && ZOOM_EXEMPT_TYPES.includes(type)) continue;

        controls.push({
          file: file.slice(WEB_ROOT.length + 1).split("\\").join("/"),
          line: source.slice(0, match.index).split("\n").length,
          sizes: attributes.match(/text-(?:xs|sm|base|lg|xl|\[[^\]]+])/g) ?? [],
        });
      }
    }
  }

  return controls;
}

/** px for a Tailwind size class, or null when it is not a size at all. */
function renderedPx(size: string): number | null {
  const scale: Record<string, number> = {
    "text-xs": 12,
    "text-sm": 14,
    "text-base": 16,
    "text-lg": 18,
    "text-xl": 20,
  };
  if (size in scale) return scale[size];

  const arbitrary = /^text-\[(\d+(?:\.\d+)?)(px|rem)]$/.exec(size);
  if (!arbitrary) return null; // e.g. text-[var(--color-ink)] — a colour.
  const value = Number(arbitrary[1]);
  return arbitrary[2] === "rem" ? value * 16 : value;
}

describe("mobile input zoom", () => {
  it("rebases the small type scale inside form controls on coarse pointers", () => {
    const css = readFileSync(join(WEB_ROOT, "app", "globals.css"), "utf8");
    const rule = /@media \(pointer: coarse\) \{[^}]*?\{[^}]*?}/.exec(css)?.[0];

    expect(rule).toBeDefined();
    expect(rule).toContain("input");
    expect(rule).toContain("select");
    expect(rule).toContain("textarea");
    expect(rule).toContain("--text-sm: 16px");
    // 16px x 1.25 is the same 20px line box text-sm has at 14px, keeping field height unchanged.
    expect(rule).toContain("--text-sm--line-height: 1.25");
  });

  it("finds the app's form controls", () => {
    // Guards the scan itself: a silently-matching-nothing regex would pass the assertion below for the wrong reason.
    expect(collectFormControls().length).toBeGreaterThan(30);
  });

  it("keeps every form control at a size the rebase covers", () => {
    const tooSmall = collectFormControls().filter((control) =>
      control.sizes.some((size) => {
        if (size === REBASED_SIZE) return false;
        const px = renderedPx(size);
        return px !== null && px < 16;
      }),
    );

    expect(
      tooSmall.map((c) => `${c.file}:${c.line} ${c.sizes.join(" ")}`),
    ).toEqual([]);
  });
});
