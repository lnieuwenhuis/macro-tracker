import { AuthCallbackClient } from "@/components/auth-callback-client";
import { getServerEnv } from "@/lib/env";

export default function ShooCallbackPage() {
  return <AuthCallbackClient shooBaseUrl={getServerEnv().shooBaseUrl} />;
}
