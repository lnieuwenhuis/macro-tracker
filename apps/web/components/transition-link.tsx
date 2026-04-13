"use client";

import Link, { type LinkProps } from "next/link";
import type { AnchorHTMLAttributes, MouseEvent } from "react";

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

export function TransitionLink({
  href,
  motion = "screen",
  onClick,
  target,
  children,
  ...props
}: TransitionLinkProps) {
  return (
    <Link
      href={href}
      target={target}
      onClick={(event) => {
        onClick?.(event);

        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          isModifiedClick(event) ||
          target === "_blank"
        ) {
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
