"use client";

import { useRef, type KeyboardEvent } from "react";

// Shared ARIA tabs keyboard/panel contract for UI-10 (gym/planner/progress/stats).
// Tabs use roving tabindex with Arrow/Home/End handling and linked tabpanels.
// Arrow handling stops propagation so the global day-navigation shortcut
// (owned separately via UI-08) never fires from an owned tab control.

export function getNextTabIndex(
  current: number,
  count: number,
  key: string,
): number | null {
  if (key === "ArrowRight" || key === "ArrowDown") {
    return (current + 1) % count;
  }

  if (key === "ArrowLeft" || key === "ArrowUp") {
    return (current - 1 + count) % count;
  }

  if (key === "Home") {
    return 0;
  }

  if (key === "End") {
    return count - 1;
  }

  return null;
}

export function useTabsKeyboard<T extends string>(
  tabIds: readonly T[],
  activeId: T,
  onChange: (next: T) => void,
) {
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  function setTabRef(id: string) {
    return (element: HTMLButtonElement | null) => {
      if (element) {
        tabRefs.current.set(id, element);
      } else {
        tabRefs.current.delete(id);
      }
    };
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const nextIndex = getNextTabIndex(index, tabIds.length, event.key);
    if (nextIndex == null) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();

    const nextId = tabIds[nextIndex];
    onChange(nextId);
    // Focus follows selection per the ARIA tabs pattern; defer so the newly
    // selected tab has rendered with tabindex 0.
    requestAnimationFrame(() => {
      tabRefs.current.get(nextId)?.focus();
    });
  }

  function tabProps(id: T, index: number, baseId: string) {
    const isActive = id === activeId;
    return {
      id: `${baseId}-tab-${id}`,
      "aria-controls": `${baseId}-panel-${id}`,
      "aria-selected": isActive,
      tabIndex: isActive ? 0 : -1,
      ref: setTabRef(id),
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) =>
        handleTabKeyDown(event, index),
    };
  }

  function panelProps(id: T, baseId: string) {
    return {
      id: `${baseId}-panel-${id}`,
      role: "tabpanel" as const,
      "aria-labelledby": `${baseId}-tab-${id}`,
      tabIndex: 0,
    };
  }

  return { setTabRef, handleTabKeyDown, tabProps, panelProps };
}
