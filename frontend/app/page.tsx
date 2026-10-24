"use client";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, setCsrf } from "@/lib/api";
import type { User } from "@/lib/types";
import { Auth, Brand } from "@/components/auth";
import { Workspace } from "@/components/workspace";
import { Button } from "@/components/ui/button";
export default function Page() {
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () =>
      api<{ user: User; csrf: string; ai_configured: boolean }>("/auth/me"),
    retry: false,
  });
  if (session.isPending)
    return (
      <main className="loading-screen">
        <Brand />
        <div className="loading-line" />
        <p className="muted">Opening your space…</p>
      </main>
    );
  if (session.data) {
    setCsrf(session.data.csrf);
    return (
      <Workspace
        user={session.data.user}
        aiConfigured={session.data.ai_configured}
      />
    );
  }
  if (session.error instanceof ApiError && session.error.status === 401)
    return (
      <Auth
        onSuccess={() => {
          void session.refetch();
        }}
      />
    );
  return (
    <main className="loading-screen">
      <Brand />
      <h2>We couldn’t reach Relay.</h2>
      <p className="muted">
        Check your connection and make sure the API is running.
      </p>
      <Button onClick={() => void session.refetch()}>Try again</Button>
    </main>
  );
}
