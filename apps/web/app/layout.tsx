import type { Metadata } from "next";
import { Fraunces, Space_Grotesk } from "next/font/google";
import Script from "next/script";

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
    var storedTheme = window.localStorage.getItem("macro-tracker-theme");
    var theme = storedTheme === "light" || storedTheme === "dark"
      ? storedTheme
      : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.classList.toggle("dark", theme === "dark");
  } catch (error) {}
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
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  );
}
