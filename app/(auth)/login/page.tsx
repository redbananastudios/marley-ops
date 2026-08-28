"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasskeySignInButton } from "@/components/auth/passkey-sign-in-button";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    // push() alone. `router.refresh()` used to follow it and fired a SECOND
    // full render of "/" — measured at 8.53s + 2.37s (office), 6.87s + 3.29s
    // (estimator) and 1.48s + 6.65s (crew) in CI run 33121391706, roughly
    // doubling the time to leave this page. It bought nothing: the auth cookie
    // is already set by the time signInWithPassword resolves, the push's own
    // RSC request carries it (those requests returned the authenticated
    // dashboard, not a redirect back here), and "/" is `force-dynamic`, so the
    // client router cache has no stale entry to clear.
    router.push("/");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm rounded-md border bg-card p-8 shadow-sm">
        <div className="mb-8 text-center">
          <p className="eyebrow mb-2">Internal use only</p>
          <h1 className="font-display text-3xl text-foreground">
            Marley <span className="text-mm-red">Ops</span>
          </h1>
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <PasskeySignInButton />
      </div>
    </main>
  );
}
