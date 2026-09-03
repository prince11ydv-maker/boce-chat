"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { Button } from "@/components/ui/Button";

export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await apiFetch("/api/auth/login", { method: "POST", body: JSON.stringify({ identifier, password }) });
      router.push("/home");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't sign in. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="grid min-h-screen lg:grid-cols-[minmax(0,480px)_1fr]">
      {/* Brand panel — deliberately narrow and asymmetric, not a centered card */}
      <section className="hidden bg-ink px-12 py-16 text-paper lg:flex lg:flex-col lg:justify-between">
        <span className="font-display text-2xl italic">Boce</span>
        <div className="max-w-xs">
          <p className="font-display text-3xl leading-snug">
            A private circle for your people — nothing more, nothing less.
          </p>
          <p className="mt-4 text-sm text-paper/60">
            Invite-only. Your school, your friends, your rules for who sees what.
          </p>
        </div>
        <p className="text-xs text-paper/40">© {new Date().getFullYear()} BOCE Chat</p>
      </section>

      {/* Form panel */}
      <section className="flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm">
          <span className="font-display text-xl italic lg:hidden">Boce</span>
          <h1 className="mt-6 text-2xl font-medium">Welcome back</h1>
          <p className="mt-1 text-sm text-ink-soft">Sign in to see what your circle's been up to.</p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-4">
            <div>
              <label htmlFor="identifier" className="mb-1.5 block text-sm font-medium">
                Username or email
              </label>
              <input
                id="identifier"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
                className="w-full rounded-xl border border-line bg-white px-4 py-2.5 text-sm outline-none focus:border-cobalt"
              />
            </div>
            <div>
              <label htmlFor="password" className="mb-1.5 block text-sm font-medium">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full rounded-xl border border-line bg-white px-4 py-2.5 text-sm outline-none focus:border-cobalt"
              />
            </div>

            {error && (
              <p role="alert" className="rounded-lg bg-coral-soft px-3 py-2 text-sm text-coral">
                {error}
              </p>
            )}

            <Button type="submit" disabled={loading} className="w-full">
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>

          <p className="mt-6 text-sm text-ink-soft">
            New here?{" "}
            <Link href="/register" className="font-medium text-cobalt hover:underline">
              You'll need an invitation code
            </Link>
          </p>
        </div>
      </section>
    </main>
  );
}
