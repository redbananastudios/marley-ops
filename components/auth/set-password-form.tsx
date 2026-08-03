"use client";

/**
 * Crew set-your-own-password form (from the emailed invite link). On success we
 * swap the returned magiclink hashed_token for a real session with the browser
 * Supabase client — mirroring the passkey sign-in — then land the crew member in
 * their portal (/my-jobs).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setCrewPasswordAction } from "@/app/auth/set-password/actions";

async function establishSession(tokenHash: string): Promise<boolean> {
  const supabase = createClient();
  const first = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
  if (!first.error) return true;
  const second = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "email" });
  return !second.error;
}

export function SetPasswordForm({ token, firstName }: { token: string; firstName: string | null }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      toast.error("Choose a password of at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      toast.error("The two passwords don't match.");
      return;
    }
    setBusy(true);
    const res = await setCrewPasswordAction(token, password);
    if (!res.ok) {
      toast.error(res.error);
      setBusy(false);
      return;
    }
    if ("tokenHash" in res && res.tokenHash) {
      const ok = await establishSession(res.tokenHash);
      if (ok) {
        router.replace("/my-jobs");
        router.refresh();
        return;
      }
    }
    // Password set but auto sign-in unavailable — send them to the login page.
    toast.success("Password set — please sign in.");
    router.replace("/login");
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <p className="text-sm text-mist-500">
        {firstName ? `Hi ${firstName} — ` : ""}choose a password for your Marley Moves crew login. You&apos;ll use
        your email and this password to sign in.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="password">New password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm">Confirm password</Label>
        <Input
          id="confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          minLength={8}
          required
        />
      </div>
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={2} /> : "Set password & sign in"}
      </Button>
    </form>
  );
}
