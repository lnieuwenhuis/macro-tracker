"use client";

import Link, { type LinkProps } from "next/link";
import { useRouter } from "next/navigation";
import type { AnchorHTMLAttributes, MouseEvent } from "react";

import { prefetchFullRoute } from "@/lib/full-prefetch";
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
  onFocus,
  onMouseEnter,
  onTouchStart,
  target,
  children,
  ...props
}: TransitionLinkProps) {
  const router = useRouter();

  function prefetchHref() {
    if (target === "_blank") {
      return;
    }

    prefetchFullRoute(router, href);
  }

  return (
    <Link
      href={href}
      target={target}
      prefetch
      onFocus={(event) => {
        onFocus?.(event);
        prefetchHref();
      }}
      onMouseEnter={(event) => {
        onMouseEnter?.(event);
        prefetchHref();
      }}
      onTouchStart={(event) => {
        onTouchStart?.(event);
        prefetchHref();
      }}
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
