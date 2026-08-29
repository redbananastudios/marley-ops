"use client";

import { useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { PlacesInput } from "@/components/places/places-input";
import { lookupPlaceDetails } from "@/lib/places/lookup";
import { submitStaffOnboardingAction } from "./actions";

/**
 * Crew sign-up form — mobile-first (opened from WhatsApp on a phone): single
 * column, 48px touch targets, one clear submit. The hidden "company" field is
 * a honeypot no human ever fills; the server silently drops those posts.
 */

const inputCls =
  "focus-ring h-12 w-full rounded-md border border-mist-200 bg-white px-3 text-base text-ink placeholder:text-mist-400";

function Field({
  id,
  label,
  optional,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
        {optional ? <span className="ml-1 font-normal text-mist-400">(optional)</span> : null}
      </label>
      {children}
    </div>
  );
}

export function JoinForm({ token }: { token: string }) {
  const [v, setV] = useState({
    full_name: "",
    date_of_birth: "",
    address_line1: "",
    address_town: "",
    address_postcode: "",
    email: "",
    phone: "",
    emergency_contact_name: "",
    emergency_contact_phone: "",
    notes: "",
    company: "", // honeypot — stays empty for humans
  });
  // The places proxies take the join token as the credential (no session here).
  const jt = `jt=${encodeURIComponent(token)}`;
  const [isDriver, setIsDriver] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneName, setDoneName] = useState<string | null>(null);

  const set = (patch: Partial<typeof v>) => setV((prev) => ({ ...prev, ...patch }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (isDriver === null) {
      setError("Tell us whether you can drive the vans.");
      return;
    }
    setError(null);
    setBusy(true);
    const res = await submitStaffOnboardingAction(token, {
      full_name: v.full_name,
      date_of_birth: v.date_of_birth,
      address_line1: v.address_line1,
      address_town: v.address_town,
      address_postcode: v.address_postcode,
      email: v.email,
      phone: v.phone,
      is_driver: isDriver,
      emergency_contact_name: v.emergency_contact_name,
      emergency_contact_phone: v.emergency_contact_phone,
      notes: v.notes,
      company: v.company,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setDoneName(v.full_name.trim().split(/\s+/)[0] || "you");
  }

  if (doneName) {
    return (
      <div className="rounded-lg border border-success-border bg-success-bg p-5 text-center sm:p-6">
        <CheckCircle2 className="mx-auto size-8 text-success" strokeWidth={1.75} />
        <h2 className="mt-3 font-brand text-2xl font-semibold text-ink">Thanks {doneName}</h2>
        <p className="mt-2 text-sm leading-relaxed text-mist-500">
          The office has your details and will be in touch.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <Field id="jn-name" label="Full name">
        <input
          id="jn-name"
          className={inputCls}
          autoComplete="name"
          value={v.full_name}
          onChange={(e) => set({ full_name: e.target.value })}
          placeholder="e.g. Jack Smith"
          required
        />
      </Field>

      <Field id="jn-dob" label="Date of birth">
        <input
          id="jn-dob"
          type="date"
          className={inputCls}
          autoComplete="bday"
          value={v.date_of_birth}
          onChange={(e) => set({ date_of_birth: e.target.value })}
          required
        />
      </Field>

      <Field id="jn-address" label="Home address">
        <PlacesInput
          id="jn-address"
          kind="address"
          className={inputCls}
          extraQuery={jt}
          value={v.address_line1}
          onValueChange={(val) => set({ address_line1: val })}
          onPick={async (p) => {
            const a = await lookupPlaceDetails(p.id, jt);
            if (!a) return;
            set({
              address_line1: a.line1 || p.description,
              address_town: a.town || v.address_town,
              address_postcode: a.postcode || v.address_postcode,
            });
          }}
          placeholder="Start typing your address…"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field id="jn-town" label="Town / City">
          <input
            id="jn-town"
            className={inputCls}
            autoComplete="address-level2"
            value={v.address_town}
            onChange={(e) => set({ address_town: e.target.value })}
            placeholder="e.g. Shaftesbury"
          />
        </Field>
        <Field id="jn-postcode" label="Postcode">
          <PlacesInput
            id="jn-postcode"
            kind="postcode"
            className={inputCls}
            extraQuery={jt}
            value={v.address_postcode}
            onValueChange={(val) => set({ address_postcode: val })}
            onPick={async (p) => {
              const a = await lookupPlaceDetails(p.id, jt);
              set({
                address_postcode: a?.postcode || p.main || v.address_postcode,
                address_town: a?.town || v.address_town,
                address_line1: a?.line1 || v.address_line1,
              });
            }}
            placeholder="SP7…"
          />
        </Field>
      </div>

      <Field id="jn-email" label="Email">
        <input
          id="jn-email"
          type="email"
          inputMode="email"
          className={inputCls}
          autoComplete="email"
          value={v.email}
          onChange={(e) => set({ email: e.target.value })}
          placeholder="name@example.com"
          required
        />
      </Field>

      <Field id="jn-phone" label="Mobile number">
        <input
          id="jn-phone"
          type="tel"
          inputMode="tel"
          className={inputCls}
          autoComplete="tel"
          value={v.phone}
          onChange={(e) => set({ phone: e.target.value })}
          placeholder="07…"
          required
        />
      </Field>

      <div className="grid gap-1.5">
        <p className="text-sm font-medium text-ink">Can you drive the vans?</p>
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Can you drive the vans?">
          {([
            [true, "Yes"],
            [false, "No"],
          ] as const).map(([val, label]) => (
            <button
              key={label}
              type="button"
              aria-pressed={isDriver === val}
              onClick={() => setIsDriver(val)}
              className={cn(
                "focus-ring h-12 rounded-md border text-base font-semibold transition-colors",
                isDriver === val
                  ? "border-mm-red bg-mm-red text-white"
                  : "border-mist-200 bg-white text-mist-500 hover:bg-mist-50",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-mist-200 bg-mist-50 p-3.5">
        <p className="text-sm font-semibold text-ink">Emergency contact</p>
        <p className="mt-0.5 text-xs leading-relaxed text-mist-500">
          Optional, but it really helps to have someone we can call if anything
          happens on a job.
        </p>
        <div className="mt-3 grid gap-3">
          <Field id="jn-ec-name" label="Their name" optional>
            <input
              id="jn-ec-name"
              className={inputCls}
              value={v.emergency_contact_name}
              onChange={(e) => set({ emergency_contact_name: e.target.value })}
              placeholder="e.g. Sarah Smith"
            />
          </Field>
          <Field id="jn-ec-phone" label="Their number" optional>
            <input
              id="jn-ec-phone"
              type="tel"
              inputMode="tel"
              className={inputCls}
              value={v.emergency_contact_phone}
              onChange={(e) => set({ emergency_contact_phone: e.target.value })}
              placeholder="07…"
            />
          </Field>
        </div>
      </div>

      <Field id="jn-notes" label="Anything else we should know" optional>
        <textarea
          id="jn-notes"
          rows={3}
          className="focus-ring w-full rounded-md border border-mist-200 bg-white px-3 py-2.5 text-base text-ink placeholder:text-mist-400"
          value={v.notes}
          onChange={(e) => set({ notes: e.target.value })}
          placeholder="Licences, experience, days you can't work…"
        />
      </Field>

      {/* Honeypot — visually removed, never announced. Humans can't fill it. */}
      <div className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
        <label htmlFor="jn-company">Company</label>
        <input
          id="jn-company"
          name="company"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={v.company}
          onChange={(e) => set({ company: e.target.value })}
        />
      </div>

      {error ? (
        <p className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="focus-ring inline-flex h-12 items-center justify-center gap-2 rounded-md bg-mm-red text-base font-semibold text-white transition-colors hover:bg-mm-red-deep disabled:opacity-60"
      >
        {busy ? <Loader2 className="size-5 animate-spin" strokeWidth={1.75} /> : null}
        Send my details
      </button>
      <p className="text-center text-xs leading-relaxed text-mist-400">
        Your details go straight to our office and nowhere else.
      </p>
    </form>
  );
}
