/**
 * @vitest-environment jsdom
 * Guards the render conditions that keep lazy modal chunks — and their
 * full-screen loading backdrops — off the initial paint of a screen.
 *
 * Reading the source is deliberate: rendering these shells needs the whole
 * server-action and navigation surface, and the defect being guarded is a
 * missing JSX condition, which is visible statically.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function readComponent(name: string) {
  return readFileSync(join(__dirname, "..", "..", "components", name), "utf8");
}

const SHELLS_WITH_BARCODE_CAPTURE = [
  "dashboard-shell.tsx",
  "recipe-builder-shell.tsx",
];

describe("lazy modal mounting", () => {
  it.each(SHELLS_WITH_BARCODE_CAPTURE)(
    "%s only mounts BarcodeCaptureModals while a capture flow is active",
    (name) => {
      const source = readComponent(name);

      // It must be lazy, or there is no chunk to defer in the first place.
      expect(source).toContain('import("./barcode-capture-modals")');

      const mountIndex = source.indexOf("<BarcodeCaptureModals");
      expect(mountIndex).toBeGreaterThan(-1);

      // The guard sits immediately above the provider that wraps the mount.
      const preceding = source.slice(Math.max(0, mountIndex - 400), mountIndex);
      expect(preceding).toMatch(
        /\{\(showScanner \|\| scanResult \|\| notFoundBarcode\) && \(/,
      );
    },
  );

  it.each(SHELLS_WITH_BARCODE_CAPTURE)(
    "%s pairs every lazy modal with a dismissal provider",
    (name) => {
      const source = readComponent(name);
      const providers = source.match(/<ModalChunkDismissProvider/g) ?? [];

      expect(providers.length).toBeGreaterThan(0);
      expect(source).toContain("ModalChunkDismissProvider");
      // A fallback rendered outside a provider throws at runtime.
      expect(providers.length).toBe(
        (source.match(/<\/ModalChunkDismissProvider>/g) ?? []).length,
      );
    },
  );

  it("recipe-builder-shell only mounts the preset modal when it is open", () => {
    const source = readComponent("recipe-builder-shell.tsx");
    const mountIndex = source.indexOf("<PresetModal");

    expect(mountIndex).toBeGreaterThan(-1);
    expect(source.slice(Math.max(0, mountIndex - 300), mountIndex)).toContain(
      "{showPresetsModal && (",
    );
  });
});
