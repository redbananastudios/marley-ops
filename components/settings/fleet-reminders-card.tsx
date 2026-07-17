"use client";

/**
 * Settings › Fleet reminders (admin). The daily cron emails + pushes these
 * recipients as MOT / Tax / Insurance / Service / Lease dates come due (28 days
 * out, then 14/7/3/day-of, then weekly overdue). The test button proves the
 * pipeline against the test inbox — it never emails the recipient list.
 */

import { useState } from "react";
import { BellRing, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { saveFleetRemindersAction, sendFleetTestAction } from "@/app/(dashboard)/settings/actions";

export function FleetRemindersCard({
  enabled: initialEnabled,
  pushEnabled: initialPush,
  recipients: initialRecipients,
}: {
  enabled: boolean;
  pushEnabled: boolean;
  recipients: string[];
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pushEnabled, setPushEnabled] = useState(initialPush);
  const [recipientText, setRecipientText] = useState(initialRecipients.join("\n"));
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  async function save() {
    const recipients = recipientText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    setBusy(true);
    const res = await saveFleetRemindersAction({ enabled, pushEnabled, recipients });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setRecipientText(res.recipients.join("\n"));
    toast.success("Fleet reminder settings saved.");
  }

  async function test() {
    setTesting(true);
    const res = await sendFleetTestAction();
    setTesting(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(`Sample reminder sent to ${res.sink}.`);
  }

  return (
    <Card className="p-0">
      <div className="flex items-center gap-3 border-b px-5 py-3.5">
        <BellRing className="size-5 shrink-0 text-mm-red" strokeWidth={1.75} />
        <div>
          <h2 className="font-display text-lg font-semibold text-foreground">Fleet reminders</h2>
          <p className="mt-0.5 text-xs text-mist-400">
            Email + push as a vehicle&apos;s MOT, tax, insurance, service or lease comes due — from 4 weeks out.
          </p>
        </div>
      </div>

      <div className="space-y-4 p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-foreground">Send reminders</p>
            <p className="text-xs text-mist-400">Master switch for the daily fleet-expiry check.</p>
          </div>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            aria-label="Send fleet reminders"
            className="size-6 shrink-0 accent-mm-red"
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-foreground">Also push to office devices</p>
            <p className="text-xs text-mist-400">A daily digest push alongside the email.</p>
          </div>
          <input
            type="checkbox"
            checked={pushEnabled}
            onChange={(e) => setPushEnabled(e.target.checked)}
            aria-label="Push fleet reminders to office devices"
            className="size-6 shrink-0 accent-mm-red"
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="fleet-recipients">Email recipients</Label>
          <textarea
            id="fleet-recipients"
            rows={3}
            value={recipientText}
            onChange={(e) => setRecipientText(e.target.value)}
            className="focus-ring w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
            placeholder={"peter@marleymoves.co.uk\nconnor@marleymoves.co.uk\nluke@marleymoves.co.uk"}
          />
          <p className="text-xs text-mist-400">One address per line. No recipients means nothing is sent.</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={save} disabled={busy} className="bg-mm-red text-white hover:bg-mm-red-deep">
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            Save
          </Button>
          <Button size="sm" variant="outline" onClick={test} disabled={testing}>
            {testing ? <Loader2 className="size-4 animate-spin" strokeWidth={2} /> : <Send className="size-4" strokeWidth={1.75} />}
            Send test alert
          </Button>
          <span className="text-xs text-mist-400">Test sends a sample to the test inbox, not the recipients.</span>
        </div>
      </div>
    </Card>
  );
}
