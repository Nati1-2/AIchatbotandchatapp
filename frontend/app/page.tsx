"use client";
import { useQuery } from "@tanstack/react-query";
import { api, setCsrf } from "@/lib/api";
import type { User } from "@/lib/types";
import { Auth, Brand } from "@/components/auth";
import { Workspace } from "@/components/workspace";

export default function Page() {
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () =>
      api<{ user: User; csrf: string; ai_configured: boolean }>("/auth/me"),
    retry: 2,
    retryDelay: 1000,
  });

  if (session.isPending) {
    return (
      <main className="loading-screen">
        <Brand />
        <div className="loading-line" />
        <p className="muted">Opening your space…</p>
      </main>
    );
  }

  if (session.data?.user) {
    setCsrf(session.data.csrf);
    return (
      <Workspace
        user={session.data.user}
        aiConfigured={session.data.ai_configured}
      />
    );
  }

  return (
    <Auth
      onSuccess={() => {
        void session.refetch();
      }}
    />
  );
}
