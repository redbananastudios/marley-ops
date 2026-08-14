import { z } from "zod";

/** Lead entry channels selectable in the Add-lead form (web is sync-only, not here). */
export const MANUAL_ENTRY_CHANNELS = [
  { value: "phone_google", label: "Phone — Google" },
  { value: "phone_facebook", label: "Phone — Facebook" },
  { value: "phone_referral", label: "Phone — Referral" },
  { value: "checkatrade", label: "Checkatrade" },
  { value: "manual", label: "Manual / walk-in" },
  { value: "referral", label: "Referral" },
] as const;

export const CHANNEL_LABELS: Record<string, string> = {
  web: "Website",
  phone_google: "Phone — Google",
  phone_facebook: "Phone — Facebook",
  phone_referral: "Phone — Referral",
  checkatrade: "Checkatrade",
  manual: "Manual / walk-in",
  referral: "Referral",
};

/** Predefined property-size (move type) options for the lead forms. */
export const PROPERTY_SIZES = [
  "Studio",
  "1 bedroom",
  "2 bedroom",
  "3 bedroom",
  "4 bedroom",
  "5 bedroom",
  "6+ bedroom",
  "Part move / few items",
  "Office / commercial",
] as const;

export const newLeadSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  /** When set, attach the lead to this existing client instead of dedupe-on-contact. */
  client_id: z.string().uuid().optional().or(z.literal("")),
  phone: z.string().trim().optional().or(z.literal("")),
  email: z.string().trim().email("Enter a valid email").optional().or(z.literal("")),
  entry_channel: z.enum(["phone_google", "phone_facebook", "phone_referral", "checkatrade", "manual", "referral"]),
  referrer_answer: z.string().trim().optional().or(z.literal("")),
  from_postcode: z.string().trim().optional().or(z.literal("")),
  to_postcode: z.string().trim().optional().or(z.literal("")),
  from_address: z.string().trim().optional().or(z.literal("")),
  to_address: z.string().trim().optional().or(z.literal("")),
  property_size: z.string().trim().optional().or(z.literal("")),
  preferred_date: z.string().trim().optional().or(z.literal("")),
  /** 3rd-party referral fee owed for this lead (£) — counted as a cost of the
   *  job in profit/margin reports. A string here (not z.coerce) so the schema's
   *  input/output types stay identical for the react-hook-form resolver; the
   *  regex forbids signs, so it's non-negative by construction. Empty = none. */
  referral_commission: z
    .string()
    .trim()
    .regex(/^(\d+(\.\d{1,2})?)?$/, "Enter a valid amount")
    .optional()
    .or(z.literal("")),
  notes: z.string().trim().optional().or(z.literal("")),
})
  .refine((v) => (v.phone && v.phone.length > 0) || (v.email && v.email.length > 0), {
    message: "Provide a phone or an email",
    path: ["phone"],
  });

export type NewLeadInput = z.infer<typeof newLeadSchema>;

/** Editable lead/customer detail fields (name + contact + move + the phone estimate). */
export const editLeadSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  phone: z.string().trim().optional().or(z.literal("")),
  email: z.string().trim().email("Enter a valid email").optional().or(z.literal("")),
  from_postcode: z.string().trim().optional().or(z.literal("")),
  to_postcode: z.string().trim().optional().or(z.literal("")),
  from_address: z.string().trim().optional().or(z.literal("")),
  to_address: z.string().trim().optional().or(z.literal("")),
  property_size: z.string().trim().optional().or(z.literal("")),
  preferred_date: z.string().trim().optional().or(z.literal("")),
  // Literal "" FIRST — z.coerce.number() turns "" into 0, so with the number
  // branch first an untouched empty money field silently stored 0 instead of
  // null on every save ("Estimate given £0" on leads that never had one).
  // Same trap + fix as storage/actions.ts optNum.
  estimate_given: z
    .union([z.literal(""), z.coerce.number().nonnegative("Must be 0 or more")])
    .optional(),
  referral_commission: z
    .union([z.literal(""), z.coerce.number().nonnegative("Must be 0 or more")])
    .optional(),
  notes: z.string().trim().optional().or(z.literal("")),
});

export type EditLeadInput = z.infer<typeof editLeadSchema>;
