"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { newLeadSchema, MANUAL_ENTRY_CHANNELS, PROPERTY_SIZES, type NewLeadInput } from "@/lib/leads/schema";
import { checkDuplicateAction, createLeadAndOpenAction } from "@/app/(dashboard)/leads/actions";
import { createQuoteWithLeadAndOpenAction } from "@/app/(dashboard)/quotes/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AddressFields,
  BLANK_ADDRESS,
  formatAddress,
  type AddressValue,
} from "@/components/places/address-fields";
import { ClientCombobox, type ClientOption } from "@/components/clients/client-combobox";
import { WindowTierPicker } from "@/components/bookings/window-tier-picker";
import { MonthSelect } from "@/components/bookings/month-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Duplicate = {
  clientName: string;
  previousLeadCount: number;
};

function Required() {
  return <span className="text-mm-red"> *</span>;
}

/** Field label + control wrapper for consistent vertical rhythm. */
function Field({
  htmlFor,
  label,
  required,
  error,
  children,
}: {
  htmlFor: string;
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-sm">
        {label}
        {required ? <Required /> : null}
      </Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

const INPUT_H = "h-11";

export function AddLeadForm({
  clients,
  mode = "lead",
  initialClientId,
}: {
  clients: ClientOption[];
  /** "lead" → save + go to the lead. "quote" → create the lead AND a draft
   *  quote seeded from it, then open the builder (the "New quote" flow). */
  mode?: "lead" | "quote";
  /** Pre-select this customer (the client page's "New quote"/"Add enquiry"
   *  entry points) — their contact details seed the form exactly as if they
   *  were picked in the combobox. */
  initialClientId?: string;
}) {
  const initialClient = initialClientId ? (clients.find((c) => c.id === initialClientId) ?? null) : null;
  const [duplicate, setDuplicate] = useState<Duplicate | null>(null);
  const [clientId, setClientId] = useState<string | null>(initialClient?.id ?? null);
  // Full pickup/destination addresses (street/town/county/postcode with Places
  // autofill) — stored on the lead as a one-line address + the postcode column.
  const [fromAddr, setFromAddr] = useState<AddressValue>(
    initialClient?.postcode ? { ...BLANK_ADDRESS, postcode: initialClient.postcode } : BLANK_ADDRESS,
  );
  const [toAddr, setToAddr] = useState<AddressValue>(BLANK_ADDRESS);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<NewLeadInput>({
    resolver: zodResolver(newLeadSchema),
    defaultValues: {
      name: initialClient?.display_name ?? "",
      phone: initialClient?.phone ?? "",
      email: initialClient?.email ?? "",
      entry_channel: "manual",
      referrer_answer: "",
      from_postcode: "",
      to_postcode: "",
      property_size: "",
      to_property_size: "",
      preferred_date: "",
      approx_month: "",
      approx_window: "",
      referral_commission: "",
      notes: "",
    },
  });

  const entryChannel = watch("entry_channel");
  const showReferrer = typeof entryChannel === "string" && entryChannel.includes("referral");

  const runDedupe = useCallback(async () => {
    const { phone, email } = getValues();
    if (!phone && !email) {
      setDuplicate(null);
      return;
    }
    try {
      const res = await checkDuplicateAction({ phone: phone || undefined, email: email || undefined });
      if (res.matched) {
        setDuplicate({ clientName: res.clientName ?? "an existing client", previousLeadCount: res.previousLeadCount });
      } else {
        setDuplicate(null);
      }
    } catch {
      // Non-blocking — dedupe is advisory only.
    }
  }, [getValues]);

  // Debounced dedupe on blur of phone/email.
  const handleDedupeBlur = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(runDedupe, 400);
  }, [runDedupe]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Picking an existing customer pre-fills their details + attaches the lead to them;
  // "New customer" clears those fields for a fresh record.
  function onClientChange(c: ClientOption | null) {
    setClientId(c?.id ?? null);
    setDuplicate(null);
    setValue("name", c?.display_name ?? "", { shouldValidate: !!c });
    setValue("phone", c?.phone ?? "", { shouldValidate: !!c });
    setValue("email", c?.email ?? "", { shouldValidate: !!c });
    setFromAddr({ ...BLANK_ADDRESS, postcode: c?.postcode ?? "" });
  }

  const onSubmit = async (values: NewLeadInput) => {
    const payload: NewLeadInput = {
      ...values,
      client_id: clientId || undefined,
      from_postcode: fromAddr.postcode.trim(),
      to_postcode: toAddr.postcode.trim(),
      from_address: formatAddress(fromAddr),
      to_address: formatAddress(toAddr),
    };
    // These actions redirect server-side on success — the navigation IS the
    // action's response, so there is no client push that could lose a race to
    // the action's revalidation and bounce back to this form (which stranded
    // users on an empty form and let them re-submit into duplicate records).
    // They only RETURN on a validation error, which we surface here.
    const res =
      mode === "quote"
        ? await createQuoteWithLeadAndOpenAction(payload)
        : await createLeadAndOpenAction(payload);
    if (res && !res.ok) toast.error(res.error);
  };

  const phoneReg = register("phone");
  const emailReg = register("email");

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6" noValidate>
      <Field htmlFor="customer" label="Customer">
        <ClientCombobox clients={clients} value={clientId} onChange={onClientChange} />
        <p className="mt-1.5 text-xs text-mist-400">
          {clientId
            ? "This lead will attach to the selected customer."
            : "Search to attach an existing customer, or leave as New customer to create one."}
        </p>
      </Field>

      <Field htmlFor="name" label="Name" required error={errors.name?.message}>
        <Input id="name" className={INPUT_H} placeholder="Customer name" {...register("name")} />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field htmlFor="phone" label="Phone" error={errors.phone?.message}>
          <Input
            id="phone"
            type="tel"
            inputMode="tel"
            className={INPUT_H}
            placeholder="07…"
            {...phoneReg}
            onBlur={(e) => {
              phoneReg.onBlur(e);
              handleDedupeBlur();
            }}
          />
        </Field>
        <Field htmlFor="email" label="Email" error={errors.email?.message}>
          <Input
            id="email"
            type="email"
            inputMode="email"
            className={INPUT_H}
            placeholder="name@example.com"
            {...emailReg}
            onBlur={(e) => {
              emailReg.onBlur(e);
              handleDedupeBlur();
            }}
          />
        </Field>
      </div>

      {duplicate ? (
        <div className="flex items-start gap-2.5 rounded-md border border-warn-border bg-warn-bg px-3.5 py-3 text-warn">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
          <p className="text-sm leading-snug">
            Matched existing client <span className="font-semibold">{duplicate.clientName}</span> —{" "}
            {duplicate.previousLeadCount}{" "}
            {duplicate.previousLeadCount === 1 ? "previous enquiry" : "previous enquiries"}. This
            lead will attach to them.
          </p>
        </div>
      ) : null}

      <Field htmlFor="entry_channel" label="Source" required error={errors.entry_channel?.message}>
        <Select
          value={entryChannel}
          onValueChange={(v) => setValue("entry_channel", v as NewLeadInput["entry_channel"], { shouldValidate: true })}
        >
          <SelectTrigger id="entry_channel" className={cn(INPUT_H, "w-full")}>
            <SelectValue placeholder="How did they reach us?" />
          </SelectTrigger>
          <SelectContent>
            {MANUAL_ENTRY_CHANNELS.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {showReferrer ? (
        <Field htmlFor="referrer_answer" label="Who referred them?" error={errors.referrer_answer?.message}>
          <Input
            id="referrer_answer"
            className={INPUT_H}
            placeholder="Name or detail of the referral"
            {...register("referrer_answer")}
          />
        </Field>
      ) : null}

      <Field
        htmlFor="referral_commission"
        label="3rd-party commission (£)"
        error={errors.referral_commission?.message}
      >
        <Input
          id="referral_commission"
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          className={INPUT_H}
          placeholder="e.g. 50"
          {...register("referral_commission")}
        />
        <p className="mt-1.5 text-xs text-mist-400">
          Only if a fee is owed to a third party for this lead — it counts as a cost of the job in
          the profit and margin reports.
        </p>
      </Field>

      {/* Full pickup + destination addresses — a postcode alone is enough to save,
          but the street lookup autofills everything for a complete record. Each
          end records its own property size (Peter, 2026-08-14). */}
      <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-lg border border-border bg-muted/30 p-4">
          <p className="mb-3 text-sm font-semibold text-foreground">Moving from</p>
          <AddressFields idPrefix="from" value={fromAddr} onChange={setFromAddr} />
          <div className="mt-4">
            <Field htmlFor="property_size" label="Property size" error={errors.property_size?.message}>
              <Select
                value={watch("property_size") || ""}
                onValueChange={(val) => setValue("property_size", val, { shouldValidate: true })}
              >
                <SelectTrigger id="property_size" className={cn(INPUT_H, "w-full bg-card")}>
                  <SelectValue placeholder="Select size" />
                </SelectTrigger>
                <SelectContent>
                  {PROPERTY_SIZES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        </section>
        <section className="rounded-lg border border-border bg-muted/30 p-4">
          <p className="mb-3 text-sm font-semibold text-foreground">Moving to</p>
          <AddressFields idPrefix="to" value={toAddr} onChange={setToAddr} />
          <div className="mt-4">
            <Field htmlFor="to_property_size" label="Property size" error={errors.to_property_size?.message}>
              <Select
                value={watch("to_property_size") || ""}
                onValueChange={(val) => setValue("to_property_size", val, { shouldValidate: true })}
              >
                <SelectTrigger id="to_property_size" className={cn(INPUT_H, "w-full bg-card")}>
                  <SelectValue placeholder="Select size" />
                </SelectTrigger>
                <SelectContent>
                  {PROPERTY_SIZES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        </section>
      </div>

      {/* Move date: a CONFIRMED date only when the customer has named a firm one
          (it feeds the quote and the payment steps), otherwise the provisional
          Beginning/Middle/End window for the schedule's demand picture. */}
      <section className="rounded-lg border border-border bg-muted/30 p-4">
        <p className="text-sm font-semibold text-foreground">Move date</p>
        <p className="mt-1 mb-4 text-xs text-mist-400">
          Only set a confirmed date when the customer has named a firm one — it flows into the
          quote and the payment steps. Not certain yet? Capture the provisional window instead.
        </p>
        <div className="grid gap-5 sm:grid-cols-3">
          <Field htmlFor="preferred_date" label="Confirmed date" error={errors.preferred_date?.message}>
            <Input id="preferred_date" type="date" className={cn(INPUT_H, "bg-card")} {...register("preferred_date")} />
          </Field>
          <Field htmlFor="approx_month" label="Provisional month" error={errors.approx_month?.message}>
            <MonthSelect
              id="approx_month"
              className={cn(INPUT_H, "w-full bg-card")}
              value={watch("approx_month") || ""}
              onChange={(v) => setValue("approx_month", v, { shouldValidate: true })}
            />
          </Field>
          <Field htmlFor="approx_window-early" label="Part of the month" error={errors.approx_window?.message}>
            <WindowTierPicker
              idPrefix="approx_window"
              value={watch("approx_window") || ""}
              onChange={(tier) => setValue("approx_window", tier, { shouldValidate: true })}
            />
          </Field>
        </div>
      </section>

      <Field htmlFor="notes" label="Notes" error={errors.notes?.message}>
        <textarea
          id="notes"
          rows={4}
          placeholder="Anything useful for the estimator…"
          className={cn(
            "w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2.5 text-sm shadow-xs transition-[color,box-shadow] outline-none",
            "placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          )}
          {...register("notes")}
        />
      </Field>

      <div className="flex items-center justify-end gap-3 border-t pt-5">
        <Button asChild variant="ghost" size="lg">
          <Link href={mode === "quote" ? "/quotes" : "/leads"}>Cancel</Link>
        </Button>
        <Button
          type="submit"
          size="lg"
          disabled={isSubmitting}
          className="bg-mm-red text-white hover:bg-mm-red/90"
        >
          {mode === "quote"
            ? isSubmitting
              ? "Starting quote…"
              : "Create quote"
            : isSubmitting
              ? "Adding…"
              : "Add lead"}
        </Button>
      </div>
    </form>
  );
}
