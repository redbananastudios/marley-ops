"use client";

/**
 * Settings › Payments (admin only). The card-payments kill switch + gateway
 * status, plus a test-payment button in test mode that proves the whole
 * pay → callback → paid loop end to end on the admin's own device.
 */

import { useEffect, useState } from "react";
import { CreditCard, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  getCardPaymentsConfigAction,
  setCardPaymentsEnabledAction,
  startTestCardPaymentAction,
  type CardPaymentsConfigView,
} from "@/app/actions/card-payments";

export function CardPaymentsCard({ testToken }: { testToken: string | null }) {
  const [cfg, setCfg] = useState<CardPaymentsConfigView | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getCardPaymentsConfigAction().then(setCfg);
  }, []);

  async function toggle(next: boolean) {
    setBusy(true);
    const res = await setCardPaymentsEnabledAction(next);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error || "Couldn't save.");
      return;
    }
    setCfg((c) => (c ? { ...c, enabled: next } : c));
    toast.success(next ? "Card payments are on." : "Card payments are off.");
  }

  async function testPay() {
    if (!testToken) {
      toast.error("No test quote available to run a payment against.");
      return;
    }
    setBusy(true);
    const res = await startTestCardPaymentAction(testToken);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error || "Couldn't start the test payment.");
      return;
    }
    const form = document.createElement("form");
    form.method = "POST";
    form.action = res.url;
    for (const [name, value] of Object.entries(res.fields)) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
  }

  return (
    <Card className="p-0">
      <div className="flex items-center gap-3 border-b px-5 py-3.5">
        <CreditCard className="size-5 shrink-0 text-mm-red" strokeWidth={1.75} />
        <div>
          <h2 className="font-display text-lg font-semibold text-foreground">Card payments</h2>
          <p className="mt-0.5 text-xs text-mist-400">
            Let customers pay their deposit by card on the accept page (takepayments).
          </p>
        </div>
      </div>

      <div className="space-y-4 p-5">
        {cfg === null ? (
          <Loader2 className="size-4 animate-spin text-mist-400" strokeWidth={1.75} />
        ) : !cfg.configured ? (
          <p className="rounded-md bg-warn-bg px-3 py-2 text-sm text-warn">
            Not connected yet — add the takepayments merchant ID and signing key to the server
            config, then this switch turns on.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-foreground">Card payments on the accept page</p>
                <p className="text-xs text-mist-400">
                  Merchant {cfg.merchantIdMasked} ·{" "}
                  <span className={cfg.testMode ? "font-semibold text-warn" : "text-mist-400"}>
                    {cfg.testMode ? "TEST mode" : "LIVE"}
                  </span>
                </p>
              </div>
              <input
                type="checkbox"
                checked={cfg.enabled}
                disabled={busy}
                onChange={(e) => toggle(e.target.checked)}
                aria-label="Card payments on the accept page"
                className="size-6 shrink-0 accent-mm-red"
              />
            </div>

            {cfg.testMode ? (
              <div className="rounded-md border border-mist-200 bg-mist-50 p-3">
                <p className="mb-2 text-xs leading-relaxed text-mist-500">
                  In test mode you can run a £1 payment through the real gateway simulator to prove
                  the full loop (pay → confirm). Nothing is charged.
                </p>
                <Button size="sm" variant="outline" disabled={busy || !testToken} onClick={testPay}>
                  {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={2} /> : "Run a test payment"}
                </Button>
                {!testToken ? (
                  <p className="mt-1.5 text-xs text-mist-400">
                    No accepted-but-unpaid test quote to run against.
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}
