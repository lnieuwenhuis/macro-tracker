import type { Metadata, Viewport } from "next";
import { Fraunces, Space_Grotesk } from "next/font/google";
import Script from "next/script";
import { Suspense } from "react";

import { ExperimentalLayoutNav } from "@/components/experimental-layout-nav";
import { AppDataCacheProvider } from "@/components/app-data-cache";
import { OfflineBanner } from "@/components/offline-banner";
import { OrientationLock } from "@/components/orientation-lock";
import { ServiceWorkerRegister } from "@/components/service-worker-register";

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
  maximumScale: 1,
  userScalable: false,
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
        <OrientationLock />
        <ServiceWorkerRegister />
        <OfflineBanner />
        <AppDataCacheProvider>
          <Suspense fallback={null}>
            <ExperimentalLayoutNav />
          </Suspense>
          {children}
        </AppDataCacheProvider>
      </body>
    </html>
  );
}
