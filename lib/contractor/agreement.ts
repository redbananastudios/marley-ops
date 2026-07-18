/**
 * Contractor agreement — the terms each self-employed worker (crew, estimator)
 * signs ONCE in their own portal before they can use contractor invoicing. The
 * signature is the per-user go-live gate + the IR35 evidence (the worker
 * confirms their own self-employed status; they generate + confirm their own
 * invoices). Kept as a versioned, pure module so a lawyer/accountant-reviewed
 * revision can supersede it by bumping the version — everyone is then re-asked
 * to sign the new version (one row per user per version).
 *
 * PLAIN-ENGLISH DRAFT — recommend an accountant/solicitor eyeball before relying
 * on it in a dispute. Bump CONTRACTOR_AGREEMENT_VERSION when the wording changes.
 */

/** Bump when the agreement wording changes → everyone re-signs the new version. */
export const CONTRACTOR_AGREEMENT_VERSION = "v1-2026-07-18";

/** The confirmations the worker must tick to sign. Stored in
 *  contractor_agreements.acknowledgments (jsonb). */
export const CONTRACTOR_ACKS = [
  {
    key: "self_employed",
    label: "I work with Marley Moves as a self-employed contractor, not as an employee.",
  },
  {
    key: "own_tax",
    label: "I'm responsible for my own Income Tax and National Insurance on what I'm paid.",
  },
  {
    key: "no_vat",
    label: "I'm not VAT registered, and I'll tell Marley Moves if that ever changes.",
  },
  {
    key: "own_invoices",
    label: "The invoices I submit are my own — I check and confirm each one before I send it.",
  },
  {
    key: "no_employee_rights",
    label: "I understand I'm not entitled to employee benefits like holiday pay, sick pay or a pension.",
  },
] as const;

export type ContractorAckKey = (typeof CONTRACTOR_ACKS)[number]["key"];

/** The fuller agreement, shown above the tick-boxes. */
export const CONTRACTOR_AGREEMENT: { title: string; intro: string; clauses: { heading: string; body: string }[] } = {
  title: "Marley Moves — Contractor Agreement",
  intro:
    "This agreement is between you (the contractor) and Marley Moves Ltd (Company No. 15914266). It sets out how we work together. Please read it, then sign at the bottom.",
  clauses: [
    {
      heading: "1. Your status",
      body: "You provide your services as a self-employed contractor running your own affairs. This is not a contract of employment. Marley Moves is not obliged to offer you work, and you are not obliged to accept work that is offered.",
    },
    {
      heading: "2. Tax and National Insurance",
      body: "You are responsible for your own Income Tax and National Insurance, and for registering with HMRC as self-employed. Marley Moves does not operate PAYE or deduct tax from what you are paid.",
    },
    {
      heading: "3. VAT",
      body: "You confirm you are not VAT registered, so your invoices carry no VAT. If you become VAT registered, you will tell Marley Moves so your invoicing can be updated.",
    },
    {
      heading: "4. How you're paid",
      body: "You invoice Marley Moves for the days and work you have done, using the invoice you build in the app. You build and submit each invoice yourself, and by submitting it you confirm the details are correct. Marley Moves pays approved invoices by bank transfer, or as otherwise agreed.",
    },
    {
      heading: "5. No employee benefits",
      body: "As a contractor you are not entitled to employee benefits such as holiday pay, sick pay, a workplace pension, redundancy pay or a notice period.",
    },
    {
      heading: "6. Doing the work",
      body: "You will carry out work with reasonable skill and care, follow reasonable site and safety instructions, and treat customers and their belongings with care.",
    },
    {
      heading: "7. Insurance",
      body: "Marley Moves holds its own business insurance (public liability and goods in transit) for the work. You remain responsible for your own affairs, including your own tax and any personal insurance you choose to hold.",
    },
    {
      heading: "8. Confidentiality",
      body: "You will keep customer details and Marley Moves business information confidential, and use them only to do the work.",
    },
    {
      heading: "9. Ending the arrangement",
      body: "Either of us can end this working arrangement at any time. You will still be paid for work you have already done and correctly invoiced.",
    },
    {
      heading: "10. Updates",
      body: "Marley Moves may update this agreement. If the terms change you will be asked to read and sign the updated version before you next invoice.",
    },
  ],
};

/** True only when EVERY acknowledgment is ticked. */
export function allContractorAcksConfirmed(acks: Record<string, boolean> | null | undefined): boolean {
  if (!acks) return false;
  return CONTRACTOR_ACKS.every((a) => acks[a.key] === true);
}

/** Coerce to a clean {key: boolean} map with exactly the known keys — never
 *  trust the client's raw object as-is into the DB. */
export function normalizeContractorAcks(acks: Record<string, boolean> | null | undefined): Record<ContractorAckKey, boolean> {
  const out = {} as Record<ContractorAckKey, boolean>;
  for (const a of CONTRACTOR_ACKS) out[a.key] = acks?.[a.key] === true;
  return out;
}
