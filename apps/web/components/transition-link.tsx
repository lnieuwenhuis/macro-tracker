"use client";

import Link, { type LinkProps, useLinkStatus } from "next/link";
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";

import {
  prepareNavigationMotion,
  type ScreenMotion,
} from "@/lib/navigation-motion";

type TransitionLinkProps = LinkProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof LinkProps> & {
    href: string;
    motion?: Exclude<ScreenMotion, "none" | "intro">;
  };

function isModifiedClick(event: MouseEvent<HTMLAnchorElement>) {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

export function shouldPrepareNavigationMotion(
  event: Pick<
    MouseEvent<HTMLAnchorElement>,
    "altKey" | "button" | "ctrlKey" | "defaultPrevented" | "metaKey" | "shiftKey"
  >,
  target?: string,
) {
  return !(
    event.defaultPrevented ||
    event.button !== 0 ||
    isModifiedClick(event as MouseEvent<HTMLAnchorElement>) ||
    target === "_blank"
  );
}

export function TransitionLink({
  href,
  motion = "screen",
  // Off by default: dynamic prefetch renders the full route server-side and hosting memory is tightly capped.
  // High-traffic links opt in individually.
  prefetch = false,
  onClick,
  target,
  children,
  ...props
}: TransitionLinkProps) {
  return (
    <Link
      href={href}
      target={target}
      prefetch={prefetch}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);

        if (!shouldPrepareNavigationMotion(event, target)) {
          return;
        }

        prepareNavigationMotion(href, motion);
      }}
      {...props}
    >
      {children}
    </Link>
  );
}

// Pulses while pending, renders nothing idle; the delay keeps fast navigations from flashing.
// Must render inside a TransitionLink/Link, which is where useLinkStatus reads from.
export function LinkPendingPulse({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const { pending } = useLinkStatus();

  return (
    <span
      className={className ? `macro-link-hint ${className}` : "macro-link-hint"}
      data-pending={pending || undefined}
    >
      {children}
    </span>
  );
}
