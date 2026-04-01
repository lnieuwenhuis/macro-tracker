"use client";

import { createShooAuth } from "@shoojs/auth";
import Link from "next/link";
import { useEffect, useState } from "react";

type AuthCallbackClientProps = {
  shooBaseUrl: string;
};

export function AuthCallbackClient({
  shooBaseUrl,
}: AuthCallbackClientProps) {
  const [message, setMessage] = useState("Finishing sign-in...");

  useEffect(() => {
    let cancelled = false;

    async function resetDevServiceWorkers() {
      if (
        process.env.NODE_ENV === "production" ||
        typeof window === "undefined" ||
        !("serviceWorker" in navigator)
      ) {
        return;
      }

      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(
        registrations.map((registration) => registration.unregister()),
      );

      if ("caches" in window) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)));
      }
    }

    async function completeSignIn() {
      const auth = createShooAuth({
        shooBaseUrl,
        callbackPath: "/auth/callback",
        requestPii: true,
      });

      try {
        const tokenResponse = await auth.finishSignIn({
          redirectAfter: false,
          consumeReturnTo: false,
        });

        if (!tokenResponse?.id_token) {
          throw new Error("Shoo did not return an id_token.");
        }

        const response = await fetch("/api/auth/shoo/verify", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            idToken: tokenResponse.id_token,
          }),
        });

        const payload = (await response.json()) as { code?: string };

        if (!response.ok) {
          auth.clearIdentity();
          const code = payload.code ?? "login_failed";
          await resetDevServiceWorkers();
          window.location.replace(`/login?error=${encodeURIComponent(code)}`);
          return;
        }

        auth.clearIdentity();
        await resetDevServiceWorkers();
        window.location.replace("/");
      } catch (error) {
        auth.clearIdentity();

        if (!cancelled) {
          setMessage(
            error instanceof Error ? error.message : "Unable to sign you in.",
          );
        }
      }
    }

    completeSignIn();

    return () => {
      cancelled = true;
    };
  }, [shooBaseUrl]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="rounded-[2rem] border border-white/70 bg-white/85 p-8 shadow-[0_24px_90px_rgba(66,37,23,0.14)] backdrop-blur">
        <h1 className="font-serif text-3xl text-[var(--color-ink)]">
          Macro Tracker
        </h1>
        <p className="mt-4 text-sm leading-6 text-[var(--color-muted)]">
          {message}
        </p>
        <Link
          href="/login"
          className="mt-6 inline-flex text-sm font-semibold text-[var(--color-accent)]"
        >
          Back to login
        </Link>
      </div>
    </main>
  );
}
