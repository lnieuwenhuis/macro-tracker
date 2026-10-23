/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDate = vi.hoisted(() => ({ value: "2026-08-18" }));

vi.mock("@/lib/startup-date", () => ({
  getLocalDateString: () => mockDate.value,
}));

const mocked = vi.hoisted(() => ({
  saveMealEntryAction: vi.fn(),
  searchFoodsAction: vi.fn(),
}));

vi.mock("@/lib/actions", () => ({
  saveMealEntryAction: mocked.saveMealEntryAction,
  searchFoodsAction: mocked.searchFoodsAction,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));

import { FoodSearchModal } from "@/components/food-search-modal";

const historyEntry = {
  id: "history-1",
  userId: "user-1",
  date: "2026-08-10",
  mealGroupId: null,
  status: "eaten",
  productId: null,
  label: "Toast",
  quantity: 1,
  unit: "serving",
  servingMultiplier: 1,
  proteinG: 5,
  carbsG: 15,
  fatG: 2,
  caloriesKcal: 120,
  sortOrder: 0,
  clientMutationId: null,
  sourceLabel: null,
};

async function searchFor(query: string) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: query } });
  await screen.findByRole("button", { name: /add today/i });
}

describe("FoodSearchModal midnight freshness (UI-22)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDate.value = "2026-08-18";
    mocked.searchFoodsAction.mockResolvedValue({
      ok: true,
      results: [historyEntry],
      products: [],
    });
  });

  it("starts new operations on the fresh day when the modal stayed mounted past midnight", async () => {
    mocked.saveMealEntryAction.mockResolvedValue({ ok: true, entry: historyEntry });
    render(<FoodSearchModal onClose={vi.fn()} onViewDate={vi.fn()} />);
    await searchFor("toast");

    // Midnight passes while the modal is still mounted.
    mockDate.value = "2026-08-19";

    fireEvent.click(screen.getByRole("button", { name: /add today/i }));

    await waitFor(() => {
      expect(mocked.saveMealEntryAction).toHaveBeenCalledTimes(1);
    });
    const input = mocked.saveMealEntryAction.mock.calls[0]![0] as {
      date: string;
      clientMutationId: string;
    };
    expect(input.date).toBe("2026-08-19");
    expect(typeof input.clientMutationId).toBe("string");
  });

  it("retries a pre-midnight attempt with its original date and idempotency key", async () => {
    mocked.saveMealEntryAction.mockResolvedValueOnce({
      ok: false,
      error: "boom",
    });
    render(<FoodSearchModal onClose={vi.fn()} onViewDate={vi.fn()} />);
    await searchFor("toast");

    fireEvent.click(screen.getByRole("button", { name: /add today/i }));
    await waitFor(() => {
      expect(mocked.saveMealEntryAction).toHaveBeenCalledTimes(1);
    });
    const first = mocked.saveMealEntryAction.mock.calls[0]![0] as {
      date: string;
      clientMutationId: string;
    };
    expect(first.date).toBe("2026-08-18");

    // Midnight passes; the retry must not duplicate onto the new day.
    mockDate.value = "2026-08-19";
    mocked.saveMealEntryAction.mockResolvedValueOnce({ ok: true, entry: historyEntry });

    fireEvent.click(screen.getByRole("button", { name: /add today/i }));
    await waitFor(() => {
      expect(mocked.saveMealEntryAction).toHaveBeenCalledTimes(2);
    });
    const second = mocked.saveMealEntryAction.mock.calls[1]![0] as {
      date: string;
      clientMutationId: string;
    };
    expect(second.date).toBe("2026-08-18");
    expect(second.clientMutationId).toBe(first.clientMutationId);
  });
});
