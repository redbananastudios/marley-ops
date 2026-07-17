import { AlertTriangle } from "lucide-react";
import { CrewDayDiagram } from "@/components/manual/crew-day-diagram";
import {
  IlluCapture,
  IlluDayList,
  IlluDeviceSetup,
  IlluDirections,
  IlluJobPage,
  IlluJobSheet,
  IlluNotes,
  IlluSignOff,
  IlluSignature,
} from "@/components/manual/phone-frames";

/**
 * The crew manual — written for the least capable reader on the team
 * (reading age ~9 by design; Peter, 2026-07-16). Short sentences. One task
 * per part, in the order of a real day. One drawn phone illustration per
 * part with a red ring on the exact tap target. PRICE-FREE by construction:
 * no money, amounts or invoices anywhere in this component — the same
 * invariant as every other crew surface. Prints cleanly as a hand-out
 * (cards avoid page breaks; app chrome is print-hidden by its own classes).
 */

/** Big-type numbered steps — larger than the office manual's Steps on purpose. */
function BigSteps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="space-y-2.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3 text-[15px] leading-7 text-foreground">
          <span className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-full bg-mm-red text-xs font-bold text-white">
            {i + 1}
          </span>
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ol>
  );
}

/** One part of the day: heading + steps on the left, phone drawing on the right. */
function CrewSection({
  n,
  title,
  illustration,
  caption,
  children,
}: {
  n: number;
  title: string;
  illustration: React.ReactNode;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={`crew-part-${n}`}
      className="scroll-mt-24 rounded-xl border border-border bg-card p-5 sm:p-6 print:break-inside-avoid"
    >
      <div className="grid gap-6 sm:grid-cols-[1fr_170px]">
        <div className="min-w-0">
          <p className="eyebrow">Part {n} of 9</p>
          <h2 className="mt-1 font-display text-2xl font-semibold tracking-[-0.02em] text-foreground">{title}</h2>
          <div className="mt-4">{children}</div>
        </div>
        <figure className="mx-auto w-[150px] shrink-0 sm:w-[170px]">
          {illustration}
          <figcaption className="mt-2 text-center text-xs font-medium text-mist-400">{caption}</figcaption>
        </figure>
      </div>
    </section>
  );
}

function CrewNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 flex gap-2.5 rounded-md border border-warn-border bg-warn-bg px-3.5 py-2.5 text-[15px] leading-7 text-warn">
      <AlertTriangle className="mt-1 size-4 shrink-0" strokeWidth={1.75} />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

export function CrewManual() {
  return (
    <div className="max-w-3xl">
      <p className="eyebrow">For the crew</p>
      <h1 className="mt-1 font-display text-3xl font-bold tracking-[-0.02em] text-foreground">
        Your day, step by step
      </h1>
      <p className="mt-2 text-[15px] leading-7 text-mist-500">
        This is how your day works. Nine short parts. Read them in order. The pictures show where to tap.
      </p>

      <div className="mt-6 print:break-inside-avoid">
        <CrewDayDiagram />
      </div>

      <div className="mt-8 space-y-6">
        <CrewSection
          n={1}
          title="Start your day"
          illustration={<IlluDayList />}
          caption="Tap a job card to open it"
        >
          <BigSteps
            items={[
              "Open the app from your home screen.",
              "Your jobs are in a list. Today is at the top.",
              "Look at the week strip. A red number on a day means you have jobs that day.",
            ]}
          />
        </CrewSection>

        <CrewSection n={2} title="Open a job" illustration={<IlluJobPage />} caption="Everything about the job, on one page">
          <BigSteps
            items={[
              "Tap the job card.",
              "You will see where to go, who you are working with, and which van.",
              <>
                Read the item list. If an item says <strong>Not moving — leave in place</strong>, leave it in the
                house.
              </>,
            ]}
          />
        </CrewSection>

        <CrewSection n={3} title="Get there" illustration={<IlluDirections />} caption="One tap opens your maps app">
          <BigSteps
            items={[
              <>
                Tap <strong>Directions</strong> on an address card.
              </>,
              "Your maps app opens with the route ready.",
              <>
                Need the customer? Tap <strong>Call</strong> at the bottom of the job page.
              </>,
            ]}
          />
        </CrewSection>

        <CrewSection
          n={4}
          title="When you arrive"
          illustration={<IlluSignature />}
          caption="They sign with a finger, on your phone"
        >
          <BigSteps
            items={[
              "Look for a yellow banner at the top of the job. It means the contract is not signed yet.",
              <>
                Tap <strong>Collect signature now</strong>.
              </>,
              "Hand the customer your phone. They sign with a finger. Done.",
            ]}
          />
          <p className="mt-3 text-[15px] leading-7 text-mist-500">No yellow banner? Good. It is already signed. Start the job.</p>
        </CrewSection>

        <CrewSection
          n={5}
          title="A problem? Write it down"
          illustration={<IlluNotes />}
          caption="Crew notes — only the office sees this"
        >
          <p className="text-[15px] leading-7 text-mist-500">
            Something wrong? Damage, or you cannot get in? This goes in <strong>Crew notes &amp; photos</strong> on
            the job.
          </p>
          <div className="mt-3">
            <BigSteps
              items={[
                <>
                  Tap <strong>Add photos</strong> and take a picture of the problem.
                </>,
                "Write a short note. Say what is wrong.",
                <>
                  Tap <strong>Save note</strong>. The office sees it straight away.
                </>,
              ]}
            />
          </div>
          <CrewNote>
            This is private. The customer never sees it. Never argue on site — save a note, then call the office.
            They will sort it out.
          </CrewNote>
        </CrewSection>

        <CrewSection
          n={6}
          title="A good moment? Get it on camera"
          illustration={<IlluCapture />}
          caption="The red camera button, on every job"
        >
          <p className="text-[15px] leading-7 text-mist-500">
            A tidy load, a before-and-after, the team working hard? We use pictures like these for our adverts and
            posts. This is a <strong>different</strong> button — the round <strong>red camera</strong>.
          </p>
          <div className="mt-3">
            <BigSteps
              items={[
                "Tap the red camera button.",
                <>
                  Choose <strong>Photo</strong>, <strong>Video</strong> or <strong>Voice</strong>. The van, the
                  outside and the team are always fine to shoot.
                </>,
                <>
                  Taking pictures <strong>inside</strong> their home? Ask the customer first. Then tap{" "}
                  <strong>Customer&apos;s OK&apos;d it</strong>. Not sure? Tap <strong>Keep internal-only</strong>.
                </>,
              ]}
            />
          </div>
          <CrewNote>
            If in doubt, ask, or keep it internal-only. The office picks the best bits — nothing is ever posted
            without a check.
          </CrewNote>
        </CrewSection>

        <CrewSection n={7} title="Finishing the job" illustration={<IlluSignOff />} caption="You both sign on your screen">
          <BigSteps
            items={[
              <>
                Tap <strong>Complete job</strong>.
              </>,
              "Did anything break or go wrong? Write it in the box. Tell the truth. It protects you.",
              "The customer signs on your screen. Then you sign.",
              "The customer gets a certificate by email. Job done.",
            ]}
          />
          <p className="mt-3 text-[15px] leading-7 text-mist-500">
            Customer not there? Tap <strong>customer absent</strong> and say why. The job still completes.
          </p>
        </CrewSection>

        <CrewSection n={8} title="The job sheet" illustration={<IlluJobSheet />} caption="A one-page brief you can print">
          <BigSteps
            items={[
              <>
                Tap <strong>Job sheet</strong> on any move.
              </>,
              "It is a one-page brief: addresses, van, items.",
              "It never shows prices. It is safe to leave in the cab.",
            ]}
          />
        </CrewSection>

        <CrewSection
          n={9}
          title="Set up your phone"
          illustration={<IlluDeviceSetup />}
          caption="Under Your device, on the My jobs page"
        >
          <BigSteps
            items={[
              <>
                On the My jobs page, find <strong>Your device</strong> at the bottom.
              </>,
              "Add the app to your home screen.",
              "Turn on job alerts. Your phone buzzes when you are put on a job.",
              "Set up face or fingerprint sign-in. No password to type.",
            ]}
          />
        </CrewSection>
      </div>

      <CrewNote>If anything on a job looks wrong, call the office before you set off.</CrewNote>
    </div>
  );
}
