type FloatingMenuPlacement = "above" | "below";

export type FloatingMenuLayout = {
  placement: FloatingMenuPlacement;
  maxHeight: number;
};

type FloatingMenuLayoutInput = {
  triggerTop: number;
  triggerBottom: number;
  menuHeight: number;
  viewportHeight: number;
  gap?: number;
  topInset?: number;
  bottomInset?: number;
};

export function getFloatingMenuLayout({
  triggerTop,
  triggerBottom,
  menuHeight,
  viewportHeight,
  gap = 4,
  topInset = 8,
  bottomInset = 8,
}: FloatingMenuLayoutInput): FloatingMenuLayout {
  const safeTop = Math.max(0, topInset);
  const safeBottom = Math.max(safeTop, viewportHeight - Math.max(0, bottomInset));
  const availableAbove = Math.max(0, triggerTop - safeTop - gap);
  const availableBelow = Math.max(0, safeBottom - triggerBottom - gap);
  const placement =
    availableBelow >= menuHeight || availableBelow >= availableAbove
      ? "below"
      : "above";

  return {
    placement,
    maxHeight: Math.floor(
      Math.max(0, placement === "below" ? availableBelow : availableAbove),
    ),
  };
}
