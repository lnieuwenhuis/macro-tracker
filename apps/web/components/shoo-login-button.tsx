"use client";

import { createShooAuth } from "@shoojs/auth";
import { useEffect, useState } from "react";

type ShooLoginButtonProps = {
  shooBaseUrl: string;
  clearIdentityOnMount?: boolean;
};

const CALLBACK_PATH = "/auth/callback";

export function ShooLoginButton({
  shooBaseUrl,
  clearIdentityOnMount = false,
}: ShooLoginButtonProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clearIdentityOnMount) {
      return;
    }

    const auth = createShooAuth({
      shooBaseUrl,
      callbackPath: CALLBACK_PATH,
      requestPii: true,
    });

    auth.clearIdentity();
  }, [clearIdentityOnMount, shooBaseUrl]);

  async function handleSignIn() {
    setPending(true);
    setError(null);

    try {
      const auth = createShooAuth({
        shooBaseUrl,
        callbackPath: CALLBACK_PATH,
        requestPii: true,
      });

      await auth.startSignIn({
        requestPii: true,
        returnTo: "/",
      });
    } catch (signInError) {
      setPending(false);
      setError(
        signInError instanceof Error
          ? signInError.message
          : "Unable to start sign-in.",
      );
    }
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={handleSignIn}
        disabled={pending}
        className="flex w-full items-center justify-center rounded-full bg-[var(--color-ink)] px-5 py-3 text-sm font-semibold text-[var(--color-paper)] transition-transform duration-150 hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-70"
      >
        {pending ? "Redirecting to Google..." : "Continue with Google"}
      </button>
      {error ? (
        <p className="text-sm text-[var(--color-danger)]">{error}</p>
      ) : null}
    </div>
  );
}
