import { CalendarDays, MapPin, Package, Phone, Truck, UserRound } from "lucide-react";
import { Card } from "@/components/ui/card";
import { buildOpItems, type QuoteFormValues } from "@/lib/quote/form-types";
import { vehicleLabelOf } from "@/lib/job-sheet-data";

/**
 * Read-only job card for /quotes/[id] — what you see when you OPEN a quote
 * (Peter, 2026-07-10: clicking a quote went straight into edit mode; viewing
 * and editing are different intents). Everything the office needs at a
 * glance; "Edit quote" switches to the wizard.
 */

const gbp = (n: number | null | undefined): string =>
  n == null || isNaN(n as number)
    ? "—"
    : "£" + Number(n).toFixed(2).replace(/\.00$/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const PACK_LABELS: Record<string, string> = {
  owner: "Owner packs",
  fragile: "Fragile-only pack",
  full: "Full pack service",
};

function fmtDate(d: string | null | undefined): string {
  if (!d) return "Date TBC";
  const t = new Date(`${d.slice(0, 10)}T00:00:00Z`);
  return isNaN(t.getTime())
    ? "Date TBC"
    : t.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function accessLine(side: QuoteFormValues["collect"]): string {
  const bits = [side.type, side.floor === "ground" ? "ground floor" : `floor: ${side.floor}`];
  if (side.lift === "yes") bits.push("lift");
  if (Number(side.accessM) > 0) bits.push(`carry ~${side.accessM}m`);
  return bits.filter(Boolean).join(" · ");
}

export interface QuoteViewMoney {
  subtotal: number | null;
  discount: number | null;
  vat_enabled: boolean;
  vat_amount: number | null;
  grand_total: number | null;
  agreed_price: number | null;
  status: string;
  deposit_amount: number | null;
  deposit_paid_at: string | null;
  moving_date: string | null;
}

export function QuoteView({ values, money }: { values: QuoteFormValues; money: QuoteViewMoney }) {
  const items = buildOpItems(values.items);
  const days = Number(values.job.days) || 1;

  const row = (label: string, value: string, strong = false) => (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-sm text-mist-500">{label}</span>
      <span className={strong ? "tabular font-display text-lg font-bold text-foreground" : "tabular text-sm font-medium text-foreground"}>
        {value}
      </span>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* customer + move */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="gap-2 p-5">
          <p className="eyebrow flex items-center gap-1.5">
            <UserRound className="size-3.5" strokeWidth={1.75} /> Customer
          </p>
          <p className="text-base font-semibold text-foreground">{values.customer.name || "—"}</p>
          <div className="space-y-1 text-sm text-mist-500">
            {values.customer.phone ? (
              <p className="flex items-center gap-2">
                <Phone className="size-3.5 shrink-0 text-mist-400" strokeWidth={1.75} />
                <a href={`tel:${values.customer.phone.replace(/\s+/g, "")}`} className="hover:underline">
                  {values.customer.phone}
                </a>
              </p>
            ) : null}
            {values.customer.email ? <p className="truncate">{values.customer.email}</p> : null}
          </div>
        </Card>
        <Card className="gap-2 p-5">
          <p className="eyebrow flex items-center gap-1.5">
            <CalendarDays className="size-3.5" strokeWidth={1.75} /> Move
          </p>
          <p className="text-base font-semibold text-foreground">
            {fmtDate(money.moving_date ?? values.job.moveDate)}
            {values.job.moveDateEstimated ? <span className="ml-1.5 text-sm font-normal text-mist-400">(estimated)</span> : null}
          </p>
          <p className="text-sm text-mist-500">
            {days}-day job · {vehicleLabelOf(values) || "vehicle TBC"} · {PACK_LABELS[values.packing] ?? values.packing}
          </p>
        </Card>
      </div>

      {/* route */}
      <div className="grid gap-4 sm:grid-cols-2">
        {(
          [
            ["Moving from", values.job.collectAddr, values.collect],
            ["Moving to", values.job.destAddr, values.dest],
          ] as const
        ).map(([title, addr, side]) => (
          <Card key={title} className="gap-1.5 p-5">
            <p className="eyebrow flex items-center gap-1.5">
              <MapPin className="size-3.5" strokeWidth={1.75} /> {title}
            </p>
            <p className="text-sm font-medium text-foreground">{addr || "—"}</p>
            <p className="text-xs capitalize text-mist-400">{accessLine(side)}</p>
          </Card>
        ))}
      </div>

      {/* inventory + money */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-0">
          <div className="border-b px-5 py-3">
            <p className="eyebrow flex items-center gap-1.5">
              <Package className="size-3.5" strokeWidth={1.75} /> Packing materials
            </p>
          </div>
          {items.length === 0 ? (
            <p className="px-5 py-6 text-sm text-mist-400">None recorded.</p>
          ) : (
            <ul className="divide-y">
              {items.map((i) => (
                <li key={i.label} className="flex items-center justify-between px-5 py-2 text-sm">
                  <span className="text-foreground">{i.label}</span>
                  <span className="tabular font-semibold text-foreground">{i.qty}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-5">
          <p className="eyebrow flex items-center gap-1.5 pb-2">
            <Truck className="size-3.5" strokeWidth={1.75} /> Money
          </p>
          {row("Subtotal", gbp(money.subtotal))}
          {Number(money.discount) > 0 ? row("Discount", `−${gbp(money.discount)}`) : null}
          {money.vat_enabled ? row("VAT (20%)", gbp(money.vat_amount)) : null}
          <div className="my-1 border-t border-border" />
          {row("Quote total", gbp(money.grand_total), true)}
          {money.status === "accepted" ? (
            <>
              {money.agreed_price != null && Number(money.agreed_price) !== Number(money.grand_total)
                ? row("Agreed price", gbp(money.agreed_price), true)
                : null}
              {row(
                "Deposit",
                money.deposit_paid_at
                  ? `${gbp(money.deposit_amount)} paid`
                  : `${gbp(money.deposit_amount)} awaiting`,
              )}
            </>
          ) : null}
        </Card>
      </div>

      {(values.survey.accessNotes || values.survey.largeItemsNotes || values.review.quoteNotes) && (
        <Card className="gap-1.5 p-5">
          <p className="eyebrow">Notes</p>
          {values.survey.accessNotes ? (
            <p className="text-sm text-foreground">
              <span className="text-mist-400">Access:</span> {values.survey.accessNotes}
            </p>
          ) : null}
          {values.survey.largeItemsNotes ? (
            <p className="text-sm text-foreground">
              <span className="text-mist-400">Large items:</span> {values.survey.largeItemsNotes}
            </p>
          ) : null}
          {values.review.quoteNotes ? <p className="text-sm text-foreground">{values.review.quoteNotes}</p> : null}
        </Card>
      )}
    </div>
  );
}
