/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  saveTemplateAction: vi.fn(),
  deleteTemplateAction: vi.fn(),
  updateTemplateAction: vi.fn(),
}));

vi.mock("@/lib/actions", () => ({
  saveTemplateAction: mocked.saveTemplateAction,
  deleteTemplateAction: mocked.deleteTemplateAction,
  updateTemplateAction: mocked.updateTemplateAction,
}));

import { useState } from "react";
import { useTemplateMutations } from "@/components/use-template-mutations";

function setup(initialLabels: string[] = []) {
  const initial = initialLabels.map((label, index) => ({
    id: `preset-${index}`,
    userId: "user-1",
    label,
    proteinG: 10,
    carbsG: 10,
    fatG: 10,
    caloriesKcal: 100,
  }));
  const presetErrorSpy = vi.fn();
  let latestResult: {
    handleSavePreset: ReturnType<typeof useTemplateMutations>["handleSavePreset"];
    handleDeletePreset: ReturnType<typeof useTemplateMutations>["handleDeletePreset"];
    items: typeof initial;
    mutation: unknown;
  } | null = null;

  function useHarness() {
    const [items, setItems] = useState(initial);
    const [mutation, setMutation] = useState<never | null>(null);
    const mutations = useTemplateMutations({
      localTemplates: items as never,
      setLocalTemplates: setItems as never,
      setPresetError: presetErrorSpy,
      setPresetMutation: setMutation as never,
    });
    latestResult = {
      handleSavePreset: mutations.handleSavePreset,
      handleDeletePreset: mutations.handleDeletePreset,
      items: items as typeof initial,
      mutation,
    };
    return latestResult;
  }

  const utils = renderHook(() => useHarness());
  return { utils, presetErrorSpy, getLatest: () => latestResult! };
}

describe("useTemplateMutations transport rejection (UI-05)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports a local error and returns false when the save transport rejects", async () => {
    mocked.saveTemplateAction.mockRejectedValue(new Error("network down"));
    const { getLatest } = setup();

    let saved: boolean | undefined;
    await act(async () => {
      saved = await getLatest().handleSavePreset({
        label: "Oats",
        proteinG: 10,
        carbsG: 20,
        fatG: 5,
        caloriesKcal: 200,
      });
    });

    expect(saved).toBe(false);
    expect(getLatest().items).toHaveLength(0);
    expect(getLatest().mutation).toBeNull();
  });

  it("rolls back the optimistic delete when the delete transport rejects", async () => {
    mocked.deleteTemplateAction.mockRejectedValue(new Error("offline"));
    const { getLatest } = setup(["Oats"]);

    let deleted: boolean | undefined;
    await act(async () => {
      deleted = await getLatest().handleDeletePreset("preset-0");
    });

    expect(deleted).toBe(false);
    expect(getLatest().items.map((t) => t.id)).toEqual(["preset-0"]);
    expect(getLatest().mutation).toBeNull();
  });

  it("recovers: a rejected save is followed by a successful save", async () => {
    mocked.saveTemplateAction
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        ok: true,
        template: {
          id: "preset-new",
          userId: "user-1",
          label: "Oats",
          proteinG: 10,
          carbsG: 20,
          fatG: 5,
          caloriesKcal: 200,
        },
      });
    const { getLatest } = setup();

    await act(async () => {
      expect(
        await getLatest().handleSavePreset({
          label: "Oats",
          proteinG: 10,
          carbsG: 20,
          fatG: 5,
          caloriesKcal: 200,
        }),
      ).toBe(false);
    });

    let saved: boolean | undefined;
    await act(async () => {
      saved = await getLatest().handleSavePreset({
        label: "Oats",
        proteinG: 10,
        carbsG: 20,
        fatG: 5,
        caloriesKcal: 200,
      });
    });

    expect(saved).toBe(true);
    expect(getLatest().items.map((t) => t.id)).toEqual(["preset-new"]);
  });
});
