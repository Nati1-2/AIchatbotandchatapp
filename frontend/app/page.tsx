"use client";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, setCsrf, getApi, setApiUrl } from "@/lib/api";
import type { User } from "@/lib/types";
import { Auth, Brand } from "@/components/auth";
import { Workspace } from "@/components/workspace";
import { Button } from "@/components/ui/button";

export default function Page() {
  const [currentApi, setCurrentApi] = useState(getApi());
  const [apiUrlInput, setApiUrlInput] = useState("");

  const session = useQuery({
    queryKey: ["session"],
    queryFn: () =>
      api<{ user: User; csrf: string; ai_configured: boolean }>("/auth/me"),
    retry: false,
  });

  useEffect(() => {
    const active = getApi();
    setCurrentApi(active);
    setApiUrlInput(active === "http://localhost:8000" ? "" : active);

    // Auto-discover backend URL from runtime /api/config if not manually set
    if (!localStorage.getItem("relay_api_url")) {
      fetch("/api/config")
        .then((res) => res.json())
        .then((data) => {
          if (data?.apiUrl && data.apiUrl !== "http://localhost:8000") {
            setApiUrl(data.apiUrl);
            setCurrentApi(data.apiUrl);
            void session.refetch();
          }
        })
        .catch(() => {});
    }
  }, []);

  const handleSaveBackend = (url: string) => {
    setApiUrl(url);
    const updated = getApi();
    setCurrentApi(updated);
    void session.refetch();
  };

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
        {session.error instanceof Error
          ? session.error.message
          : "Check your connection and make sure the API is running."}
      </p>

      <div className="text-xs text-muted-foreground font-mono opacity-80 mt-2 p-2 bg-secondary/30 rounded border border-border">
        Target API: {currentApi}
      </div>

      <div className="mt-4 flex flex-col gap-2 max-w-sm w-full mx-auto p-4 bg-card rounded-lg border border-border shadow-sm text-left">
        <label className="text-xs font-semibold text-foreground">
          Connect to Render Backend:
        </label>
        <p className="text-[11px] text-muted-foreground">
          Enter your Render backend URL (e.g. <code>https://relay-backend-xxxx.onrender.com</code>):
        </p>
        <div className="flex gap-2 mt-1">
          <input
            type="url"
            placeholder="https://relay-backend-xxxx.onrender.com"
            value={apiUrlInput}
            onChange={(e) => setApiUrlInput(e.target.value)}
            className="flex-1 px-3 py-1.5 text-xs bg-background border border-border rounded text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <Button
            size="sm"
            onClick={() => handleSaveBackend(apiUrlInput)}
          >
            Connect
          </Button>
        </div>
      </div>

      <div className="mt-3">
        <Button variant="ghost" size="sm" onClick={() => void session.refetch()}>
          Retry connection
        </Button>
      </div>
    </main>
  );
}
