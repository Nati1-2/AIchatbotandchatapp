"use client";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ArrowUpRight,
  ArrowRight,
  MessageSquare,
  ShieldCheck,
  Users,
  LoaderCircle,
} from "lucide-react";
import { Button } from "./ui/button";
import { mutate, setCsrf } from "@/lib/api";
import type { User } from "@/lib/types";
const schema = z.object({
  username: z
    .string()
    .regex(
      /^[a-z0-9_]{3,32}$/,
      "Use 3–32 lowercase letters, numbers or underscores.",
    ),
  password: z.string().min(10, "Use at least 10 characters.").max(128),
  display_name: z.string().max(80),
});
export function Brand() {
  return (
    <span className="brand">
      <span className="brand-icon">
        <ArrowUpRight size={24} strokeWidth={2.5} />
      </span>
      relay<span className="brand-dot">.</span>
    </span>
  );
}
export function Auth({ onSuccess }: { onSuccess: () => void }) {
  const [register, setRegister] = useState(false);
  const [error, setError] = useState("");
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { username: "", password: "", display_name: "" },
  });
  async function submit(values: z.infer<typeof schema>) {
    setError("");
    try {
      const data = await mutate<{ user: User; csrf: string }>(
        register ? "/auth/register" : "/auth/login",
        values,
      );
      setCsrf(data.csrf);
      onSuccess();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <main className="auth-page">
      <section className="auth-story">
        <Brand />
        <div className="auth-story-copy">
          <span className="eyebrow">LESS NOISE. MORE CONNECTION.</span>
          <h1>
            Good conversations
            <br />
            start here<span className="accent">.</span>
          </h1>
          <p>
            A space for your people, your projects,
            <br />
            and whatever comes next.
          </p>
          <div className="sample-chat" aria-hidden="true">
            <div className="sample-caption">
              <span className="avatar">RD</span>
              <div>
                Relay design team<small>Ideas feel better together</small>
              </div>
              <span className="status-dot" />
            </div>
            <div className="sample-bubble">Small details. Big difference.</div>
            <div className="sample-bubble outgoing">
              Let’s make something great. <span>✓✓</span>
            </div>
          </div>
        </div>
        <div className="auth-foot">
          <span>
            <MessageSquare size={16} /> Conversations that flow
          </span>
          <span>
            <ShieldCheck size={16} /> Your space, thoughtfully built
          </span>
        </div>
      </section>
      <section className="auth-form-panel">
        <div className="auth-form">
          <span className="eyebrow">YOUR NEXT CONVERSATION AWAITS</span>
          <h2>{register ? "Make yourself at home." : "Welcome back."}</h2>
          <p className="muted">
            {register
              ? "Create your Relay account to get started."
              : "Sign in to pick up where you left off."}
          </p>
          <form onSubmit={form.handleSubmit(submit)}>
            {register && (
              <label>
                Display name
                <input
                  autoComplete="name"
                  placeholder="How people will see you"
                  {...form.register("display_name")}
                />
              </label>
            )}
            <label>
              Username
              <input
                autoComplete="username"
                placeholder="your_username"
                {...form.register("username")}
              />
              {form.formState.errors.username && (
                <span className="field-error">
                  {form.formState.errors.username.message}
                </span>
              )}
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete={register ? "new-password" : "current-password"}
                placeholder="At least 10 characters"
                {...form.register("password")}
              />
              {form.formState.errors.password && (
                <span className="field-error">
                  {form.formState.errors.password.message}
                </span>
              )}
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? (
                <LoaderCircle className="spin" size={18} />
              ) : (
                <>
                  {register ? "Create account" : "Sign in"}
                  <ArrowRight size={18} />
                </>
              )}
            </Button>
          </form>
          <p className="auth-switch">
            {register ? "Already part of Relay?" : "New around here?"}{" "}
            <button
              onClick={() => {
                setRegister(!register);
                setError("");
              }}
            >
              {register ? "Sign in" : "Create an account"}
            </button>
          </p>
          <div className="auth-note">
            <Users size={18} />
            <span>
              One place for direct messages, group conversations, and a little
              help from AI.
            </span>
          </div>
        </div>
        <small className="auth-legal">Made for meaningful connections.</small>
      </section>
    </main>
  );
}
