import type { Metadata, Viewport } from "next";
import { Fraunces, Space_Grotesk } from "next/font/google";
import Script from "next/script";
import { Suspense } from "react";

import { LayoutNav } from "@/components/layout-nav";
import { OfflineBanner } from "@/components/offline-banner";
import { OrientationLock } from "@/components/orientation-lock";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import {
  TIMEZONE_COOKIE_MAX_AGE_SECONDS,
  TIMEZONE_COOKIE_NAME,
} from "@/lib/timezone";

import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  title: "Macro Tracker",
  description: "Track daily meals and compare macro averages across time.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Macro Tracker",
    statusBarStyle: "default",
  },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-touch-icon.svg", type: "image/svg+xml" }],
  },
};

const themeInitScript = `
  try {
    var VALID = ["sandstone","ember","ocean","forest","sakura","lavender","midnight","arctic","mint","crimson","nord","dusk"];
    var DARK = {ember:1,ocean:1,forest:1,midnight:1,crimson:1,nord:1,dusk:1};
    var stored = window.localStorage.getItem("macro-tracker-theme");
    if (stored === "light") { stored = "sandstone"; window.localStorage.setItem("macro-tracker-theme", stored); }
    if (stored === "dark")  { stored = "ember";     window.localStorage.setItem("macro-tracker-theme", stored); }
    var theme = VALID.indexOf(stored) > -1
      ? stored
      : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "ember" : "sandstone");
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.colorScheme = DARK[theme] ? "dark" : "light";
  } catch (e) {}
`;

// Runs while the initial HTML is parsed, so the zone is already on the cookie
// jar for every subsequent request — including the RSC fetches a client-side
// navigation makes. Server code can then resolve the user's own calendar day.
const timeZoneInitScript = `
  try {
    var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) {
      var encoded = encodeURIComponent(tz);
      if (document.cookie.split("; ").indexOf(${JSON.stringify(TIMEZONE_COOKIE_NAME)} + "=" + encoded) === -1) {
        document.cookie = ${JSON.stringify(TIMEZONE_COOKIE_NAME)} + "=" + encoded
          + "; path=/; max-age=${TIMEZONE_COOKIE_MAX_AGE_SECONDS}; samesite=lax"
          + (location.protocol === "https:" ? "; secure" : "");
      }
    }
  } catch (e) {}
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${spaceGrotesk.variable} ${fraunces.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Script id="theme-init" strategy="beforeInteractive">
          {themeInitScript}
        </Script>
        <Script id="timezone-init" strategy="beforeInteractive">
          {timeZoneInitScript}
        </Script>
        <OrientationLock />
        <ServiceWorkerRegister />
        <OfflineBanner />
        <Suspense fallback={null}>
          <LayoutNav />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
