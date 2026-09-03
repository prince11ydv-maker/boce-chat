"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { Button } from "@/components/ui/Button";

const initialForm = {
  invitationCode: "",
  fullName: "",
  username: "",
  dateOfBirth: "",
  school: "",
  email: "",
  password: "",
};

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState(initialForm);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function update<K extends keyof typeof initialForm>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await apiFetch("/api/auth/register", { method: "POST", body: JSON.stringify(form) });
      router.push("/home");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't create your account. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="grid min-h-screen lg:grid-cols-[minmax(0,480px)_1fr]">
      <section className="hidden bg-ink px-12 py-16 text-paper lg:flex lg:flex-col lg:justify-between">
        <span className="font-display text-2xl italic">Boce</span>
        <div className="max-w-xs">
          <p className="font-display text-3xl leading-snug">You'll need a code to get in.</p>
          <p className="mt-4 text-sm text-paper/60">
            BOCE Chat is invite-only — ask a friend, your school community, or an admin for a code.
          </p>
        </div>
        <p className="text-xs text-paper/40">© {new Date().getFullYear()} BOCE Chat</p>
      </section>

      <section className="flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm">
          <span className="font-display text-xl italic lg:hidden">Boce</span>
          <h1 className="mt-6 text-2xl font-medium">Create your account</h1>
          <p className="mt-1 text-sm text-ink-soft">Full name, date of birth, and school can't be changed later without admin approval — enter them carefully.</p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-4">
            <Field label="Invitation code" value={form.invitationCode} onChange={(v) => update("invitationCode", v)} required />
            <Field label="Full name" value={form.fullName} onChange={(v) => update("fullName", v)} required />
            <Field label="Username" value={form.username} onChange={(v) => update("username", v)} required />
            <Field label="Date of birth" type="date" value={form.dateOfBirth} onChange={(v) => update("dateOfBirth", v)} required />
            <Field label="School / college" value={form.school} onChange={(v) => update("school", v)} required />
            <Field label="Email (optional)" type="email" value={form.email} onChange={(v) => update("email", v)} />
            <Field label="Password" type="password" value={form.password} onChange={(v) => update("password", v)} required />

            {error && (
              <p role="alert" className="rounded-lg bg-coral-soft px-3 py-2 text-sm text-coral">
                {error}
              </p>
            )}

            <Button type="submit" disabled={loading} className="w-full">
              {loading ? "Creating account…" : "Create account"}
            </Button>
          </form>

          <p className="mt-6 text-sm text-ink-soft">
            Already have an account?{" "}
            <Link href="/" className="font-medium text-cobalt hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </section>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
}) {
  const id = label.toLowerCase().replace(/[^a-z]+/g, "-");
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-line bg-white px-4 py-2.5 text-sm outline-none focus:border-cobalt"
      />
    </div>
  );
}
