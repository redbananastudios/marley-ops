"use client";

/**
 * Team management (admin only) — the profiles behind the shared login model.
 * List each user with role + active controls, set a new password, and add a
 * new login. Self-lockout is blocked server-side (and the controls disable
 * on your own row).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2, Plus, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createTeamUserAction,
  updateTeamUserAction,
  resetTeamPasswordAction,
  deleteTeamUserAction,
} from "@/app/(dashboard)/settings/team-actions";

export interface TeamMember {
  id: string;
  full_name: string;
  email: string | null;
  role: string;
  active: boolean;
}

export function TeamForm({ users, meId }: { users: TeamMember[]; meId: string | null }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [pwFor, setPwFor] = useState<TeamMember | null>(null);
  const [delFor, setDelFor] = useState<TeamMember | null>(null);

  async function run(id: string, fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) {
    setBusyId(id);
    const res = await fn();
    setBusyId(null);
    if (!res.ok) toast.error(res.error || "Something went wrong.");
    else {
      toast.success(ok);
      router.refresh();
    }
  }

  return (
    <Card className="p-0">
      <div className="flex items-center justify-between border-b px-5 py-3.5">
        <div>
          <h2 className="font-display text-lg font-semibold text-foreground">Team &amp; roles</h2>
          <p className="mt-0.5 text-xs text-mist-400">
            Admins manage settings + team; estimators run leads, quotes and the diary; crew see only their assigned jobs.
          </p>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)} className="h-9">
          <Plus className="size-4" strokeWidth={2} />
          Add user
        </Button>
      </div>

      <ul className="divide-y">
        {users.map((u) => {
          const isMe = u.id === meId;
          const busy = busyId === u.id;
          return (
            <li key={u.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                <UserRound className="size-4 text-mist-400" strokeWidth={1.75} />
              </span>
              {/* min-w-[9rem], not min-w-0: with the wrapping row, a zero
                  minimum let the role/buttons squeeze the name down to one
                  letter on phones — hold the name and wrap the controls. */}
              <div className="min-w-[9rem] flex-1">
                <p className="truncate text-sm font-semibold text-foreground">
                  {u.full_name || "Unnamed"}
                  {isMe ? <span className="ml-1.5 text-xs font-normal text-mist-400">(you)</span> : null}
                  {!u.active ? (
                    <span className="ml-1.5 rounded-pill bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-mist-400">
                      Inactive
                    </span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-mist-400">{u.email || "—"}</p>
              </div>

              {busy ? <Loader2 className="size-4 animate-spin text-mist-400" strokeWidth={1.75} /> : null}

              <Select
                value={u.role}
                onValueChange={(role) =>
                  run(u.id, () => updateTeamUserAction(u.id, { role: role as "admin" | "estimator" | "crew" }), "Role updated.")
                }
                disabled={busy || isMe}
              >
                <SelectTrigger className="h-9 w-[130px]" aria-label={`Role for ${u.full_name}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="estimator">Estimator</SelectItem>
                  <SelectItem value="crew">Crew</SelectItem>
                </SelectContent>
              </Select>

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9"
                disabled={busy || isMe}
                onClick={() =>
                  run(u.id, () => updateTeamUserAction(u.id, { active: !u.active }), u.active ? "Deactivated." : "Reactivated.")
                }
              >
                {u.active ? "Deactivate" : "Reactivate"}
              </Button>

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9"
                disabled={busy}
                onClick={() => setPwFor(u)}
                aria-label={`Set password for ${u.full_name}`}
              >
                <KeyRound className="size-4" strokeWidth={1.75} />
                Password
              </Button>

              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                className="size-9 text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={busy || isMe}
                onClick={() => setDelFor(u)}
                aria-label={`Delete ${u.full_name}`}
                title={isMe ? "You can't delete your own account" : "Delete this login"}
              >
                <Trash2 className="size-4" strokeWidth={1.75} />
              </Button>
            </li>
          );
        })}
      </ul>

      <AddUserDialog open={addOpen} onOpenChange={setAddOpen} />
      <PasswordDialog user={pwFor} onOpenChange={(v) => !v && setPwFor(null)} />
      <DeleteUserDialog user={delFor} onOpenChange={(v) => !v && setDelFor(null)} />
    </Card>
  );
}

function DeleteUserDialog({ user, onOpenChange }: { user: TeamMember | null; onOpenChange: (v: boolean) => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!user) return;
    setBusy(true);
    const res = await deleteTeamUserAction(user.id);
    setBusy(false);
    if (!res.ok) {
      // Users with history are refused server-side — surface the reason so the
      // office knows to Deactivate instead.
      toast.error(res.error || "Could not delete the user.");
      return;
    }
    toast.success(`${user.full_name || "User"} deleted.`);
    onOpenChange(false);
    router.refresh();
  }

  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display">Delete user?</DialogTitle>
          <DialogDescription>
            {user
              ? `Permanently removes ${user.full_name || "this login"} (${user.email || "no email"}). This can't be undone. If they have any history in the system you'll be asked to deactivate instead.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy} className="h-10">
            Cancel
          </Button>
          <Button variant="destructive" onClick={submit} disabled={busy} className="h-10">
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <Trash2 className="size-4" strokeWidth={1.75} />}
            Delete user
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<"admin" | "estimator" | "crew">("estimator");
  const [password, setPassword] = useState("");

  async function submit() {
    setBusy(true);
    const res = await createTeamUserAction({ email, fullName, role, password });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error || "Could not create the user.");
      return;
    }
    toast.success("User created.");
    onOpenChange(false);
    setEmail("");
    setFullName("");
    setRole("estimator");
    setPassword("");
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">Add user</DialogTitle>
          <DialogDescription>Creates a login they can use straight away.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <div className="grid gap-2">
            <Label htmlFor="team-name">Name</Label>
            <Input id="team-name" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Full name" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="team-email">Email</Label>
            <Input id="team-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@marleymoves.co.uk" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="team-role">Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as "admin" | "estimator" | "crew")}>
                <SelectTrigger id="team-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="estimator">Estimator</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="crew">Crew</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="team-pw">Password</Label>
              <Input id="team-pw" type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min 8 characters" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy} className="h-10">
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy} className="h-10">
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            Create user
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PasswordDialog({ user, onOpenChange }: { user: TeamMember | null; onOpenChange: (v: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");

  async function submit() {
    if (!user) return;
    setBusy(true);
    const res = await resetTeamPasswordAction(user.id, password);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error || "Could not set the password.");
      return;
    }
    toast.success(`Password updated for ${user.full_name}.`);
    setPassword("");
    onOpenChange(false);
  }

  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display">Set password</DialogTitle>
          <DialogDescription>{user ? `New password for ${user.full_name}.` : ""}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-1">
          <Label htmlFor="pw-new">New password</Label>
          <Input id="pw-new" type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min 8 characters" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy} className="h-10">
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || password.length < 8} className="h-10">
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            Save password
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
