import { AuthCallbackClient } from "@/components/auth-callback-client";

const shooBaseUrl =
  process.env.NEXT_PUBLIC_SHOO_BASE_URL ??
  process.env.SHOO_BASE_URL ??
  "https://shoo.dev";

export default function ShooCallbackPage() {
  return <AuthCallbackClient shooBaseUrl={shooBaseUrl} />;
}
