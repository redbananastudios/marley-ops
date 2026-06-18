"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { newLeadSchema, MANUAL_ENTRY_CHANNELS, type NewLeadInput } from "@/lib/leads/schema";
import { checkDuplicateAction, createLeadAction } from "@/app/(dashboard)/leads/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

export function AddLeadForm() {
  const router = useRouter();
  const [duplicate, setDuplicate] = useState<Duplicate | null>(null);
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
      name: "",
      phone: "",
      email: "",
      entry_channel: "manual",
      referrer_answer: "",
      from_postcode: "",
      to_postcode: "",
      property_size: "",
      preferred_date: "",
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

  const onSubmit = async (values: NewLeadInput) => {
    const res = await createLeadAction(values);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("Lead added");
    router.push(`/leads/${res.leadId}`);
  };

  const phoneReg = register("phone");
  const emailReg = register("email");

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6" noValidate>
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

      <div className="grid gap-5 sm:grid-cols-2">
        <Field htmlFor="from_postcode" label="From postcode" error={errors.from_postcode?.message}>
          <Input id="from_postcode" className={INPUT_H} placeholder="SP7 9PX" {...register("from_postcode")} />
        </Field>
        <Field htmlFor="to_postcode" label="To postcode" error={errors.to_postcode?.message}>
          <Input id="to_postcode" className={INPUT_H} placeholder="BA8 0TG" {...register("to_postcode")} />
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field htmlFor="property_size" label="Property size" error={errors.property_size?.message}>
          <Input id="property_size" className={INPUT_H} placeholder="3-bed house" {...register("property_size")} />
        </Field>
        <Field htmlFor="preferred_date" label="Preferred date" error={errors.preferred_date?.message}>
          <Input id="preferred_date" type="date" className={INPUT_H} {...register("preferred_date")} />
        </Field>
      </div>

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
          <Link href="/leads">Cancel</Link>
        </Button>
        <Button
          type="submit"
          size="lg"
          disabled={isSubmitting}
          className="bg-mm-red text-white hover:bg-mm-red/90"
        >
          {isSubmitting ? "Adding…" : "Add lead"}
        </Button>
      </div>
    </form>
  );
}
