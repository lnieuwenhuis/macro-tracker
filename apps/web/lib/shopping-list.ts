import type { DailySummary, QuantityUnit } from "@macro-tracker/db";

export type ShoppingListItem = {
  label: string;
  unit: QuantityUnit;
  quantity: number;
  dates: string[];
  sourceCount: number;
  notes: string[];
};

function normalizeLabel(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function formatQuantity(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatShoppingListText(items: ShoppingListItem[]) {
  if (items.length === 0) {
    return "No planned items in this range.";
  }

  return items
    .map((item) => {
      const notes = item.notes.length > 0 ? ` (${item.notes.join("; ")})` : "";
      return `- ${item.label}: ${formatQuantity(item.quantity)} ${item.unit}${notes}`;
    })
    .join("\n");
}

export function buildShoppingList(summaries: DailySummary[]): ShoppingListItem[] {
  const itemsByKey = new Map<string, ShoppingListItem>();

  for (const summary of summaries) {
    for (const meal of summary.meals) {
      if (meal.status !== "planned") {
        continue;
      }

      const normalizedLabel = normalizeLabel(meal.label);
      if (!normalizedLabel) {
        continue;
      }

      const key = `${normalizedLabel}|${meal.unit}`;
      const quantity =
        Number.isFinite(meal.quantity) && meal.quantity > 0 ? meal.quantity : 0;
      const existing = itemsByKey.get(key);

      if (!existing) {
        itemsByKey.set(key, {
          label: meal.label.trim(),
          unit: meal.unit,
          quantity,
          dates: [summary.date],
          sourceCount: 1,
          notes: quantity > 0 ? [] : ["missing quantity"],
        });
        continue;
      }

      existing.quantity += quantity;
      existing.sourceCount += 1;
      if (!existing.dates.includes(summary.date)) {
        existing.dates.push(summary.date);
      }
      if (quantity <= 0 && !existing.notes.includes("missing quantity")) {
        existing.notes.push("missing quantity");
      }
    }
  }

  return Array.from(itemsByKey.values())
    .map((item) => ({
      ...item,
      quantity: Math.round(item.quantity * 100) / 100,
      dates: [...item.dates].sort(),
      notes: item.sourceCount > 1
        ? [...item.notes, `${item.sourceCount} planned entries`]
        : item.notes,
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.unit.localeCompare(b.unit));
}
