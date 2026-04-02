import { redirect } from "next/navigation";

import { ShooLoginButton } from "@/components/shoo-login-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { getCurrentSessionUser } from "@/lib/auth";

type LoginPageProps = {
  searchParams: Promise<{
    error?: string;
    loggedOut?: string;
  }>;
};

const ERROR_MESSAGES: Record<string, string> = {
  login_failed: "Sign-in did not complete. Please try again.",
  missing_email: "Google did not provide an email address for this account.",
  invalid_token: "The Shoo token could not be verified.",
  session_expired: "Your local session expired. Please sign in again.",
};

const shooBaseUrl =
  process.env.NEXT_PUBLIC_SHOO_BASE_URL ??
  process.env.SHOO_BASE_URL ??
  "https://shoo.dev";

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const sessionUser = await getCurrentSessionUser();
  if (sessionUser) {
    redirect("/");
  }

  const params = await searchParams;
  const clearIdentityOnMount = params.loggedOut === "1";
  const errorMessage = params.error ? ERROR_MESSAGES[params.error] : null;
  const loggedOut = clearIdentityOnMount;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-6 sm:px-6 sm:py-12">
      <div className="rounded-[2rem] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[0_24px_90px_rgba(66,37,23,0.14)] backdrop-blur sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--color-muted-strong)]">
            Macro Tracker
          </p>
          <ThemeToggle />
        </div>
        <h1 className="mt-5 font-serif text-3xl leading-tight text-[var(--color-ink)] sm:text-4xl">
          Daily macros, built for your phone.
        </h1>
        <p className="mt-4 text-sm leading-7 text-[var(--color-muted)]">
          Sign in with your Google account to log meals, review daily
          totals, and compare your weekly and monthly averages.
        </p>

        {loggedOut ? (
          <p className="mt-5 rounded-2xl bg-[var(--color-card-muted)] px-4 py-3 text-sm text-[var(--color-muted-strong)]">
            You have been signed out.
          </p>
        ) : null}

        {errorMessage ? (
          <p className="mt-5 rounded-2xl border border-[var(--color-danger)]/20 bg-[var(--color-danger)]/8 px-4 py-3 text-sm text-[var(--color-danger)]">
            {errorMessage}
          </p>
        ) : null}

        <div className="mt-7">
          <ShooLoginButton
            shooBaseUrl={shooBaseUrl}
            clearIdentityOnMount={clearIdentityOnMount}
          />
        </div>
      </div>
    </main>
  );
}
