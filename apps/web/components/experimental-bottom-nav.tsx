"use client";

import type { ScreenMotion } from "@/lib/navigation-motion";

import { TransitionLink } from "./transition-link";

type Tab = "log" | "progress" | "recipes" | "summary";

type ExperimentalBottomNavProps = {
  activeTab: Tab;
  selectedDate: string;
  onAdd: () => void;
};

type NavItem = {
  id: Tab;
  label: string;
  href: string;
  icon: React.ReactNode;
};

const TAB_ORDER: Record<Tab, number> = {
  log: 0,
  progress: 1,
  recipes: 2,
  summary: 3,
};

export function ExperimentalBottomNav({
  activeTab,
  selectedDate,
  onAdd,
}: ExperimentalBottomNavProps) {
  const items: NavItem[] = [
    {
      id: "log",
      label: "Food Log",
      href: `/?date=${selectedDate}`,
      icon: (
        <svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 3h11v11H3z" />
          <path d="M3 7h11" />
          <path d="M7 7v7" />
        </svg>
      ),
    },
    {
      id: "progress",
      label: "Progress",
      href: `/progress?date=${selectedDate}&tab=goals`,
      icon: (
        <svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 12.5h12" />
          <path d="M4.5 10.5l2.3-3 2.3 1.7 3.4-4.2" />
          <circle cx="12.5" cy="5" r="1" fill="currentColor" stroke="none" />
        </svg>
      ),
    },
    {
      id: "recipes",
      label: "Recipes",
      href: `/recipes?date=${selectedDate}`,
      icon: (
        <svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2.5" y="2.5" width="12" height="12" rx="2" />
          <path d="M5 6h7" />
          <path d="M5 9h7" />
          <path d="M5 12h4" />
        </svg>
      ),
    },
    {
      id: "summary",
      label: "Summary",
      href: `/summary?date=${selectedDate}`,
      icon: (
        <svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2.5" y="9.5" width="2.5" height="5" />
          <rect x="7.25" y="6" width="2.5" height="8.5" />
          <rect x="12" y="2.5" width="2.5" height="12" />
        </svg>
      ),
    },
  ];

  const leftItems = items.slice(0, 2);
  const rightItems = items.slice(2);

  return (
    <nav
      aria-label="Primary"
      className="pointer-events-auto h-[4.3rem] rounded-[1.55rem] border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface-strong)_88%,transparent)] px-1.5 py-1 shadow-[0_16px_30px_rgba(0,0,0,0.15)] backdrop-blur-xl"
    >
      <div className="grid h-full grid-cols-[1fr_1fr_auto_1fr_1fr] items-stretch gap-0">
        {leftItems.map((item) => (
          <NavLink
            key={item.id}
            item={item}
            active={activeTab === item.id}
            activeTab={activeTab}
          />
        ))}

        <div className="flex h-full items-center justify-center px-0.5">
          <button
            type="button"
            onClick={onAdd}
            aria-label="Add food"
            className="flex h-[3rem] w-[3rem] items-center justify-center rounded-full bg-[var(--color-accent)] text-white shadow-[0_12px_24px_rgba(0,0,0,0.2)] transition hover:-translate-y-0.5"
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>

        {rightItems.map((item) => (
          <NavLink
            key={item.id}
            item={item}
            active={activeTab === item.id}
            activeTab={activeTab}
          />
        ))}
      </div>
    </nav>
  );
}

function NavLink({
  item,
  active,
  activeTab,
}: {
  item: NavItem;
  active: boolean;
  activeTab: Tab;
}) {
  const targetIndex = TAB_ORDER[item.id];
  const currentIndex = TAB_ORDER[activeTab];
  const motion: Exclude<ScreenMotion, "none" | "intro"> =
    targetIndex > currentIndex ? "screen-forward"
    : targetIndex < currentIndex ? "screen-backward"
    : "screen";

  return (
    <TransitionLink
      href={item.href}
      motion={motion}
      className={[
        "flex h-full min-w-0 flex-col items-center justify-center gap-0.5 rounded-[0.95rem] px-1 py-0.5 text-center transition",
        active
          ? "bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-[var(--color-accent)]"
          : "text-[var(--color-muted)] hover:bg-[var(--color-card-muted)] hover:text-[var(--color-ink)]",
      ].join(" ")}
      aria-current={active ? "page" : undefined}
    >
      <span className="flex h-5 w-5 items-center justify-center rounded-full">
        {item.icon}
      </span>
      <span className="text-[7.5px] font-semibold uppercase leading-tight tracking-[0.08em]">
        {item.label}
      </span>
    </TransitionLink>
  );
}
