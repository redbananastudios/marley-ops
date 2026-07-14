import { Section, Steps, Note, Kbd } from "@/components/manual/manual-ui";

export function SendingEmails() {
  return (
    <Section id="sending-emails" eyebrow="Reference" title="Sending emails (or texts) from the panel">
      <Steps
        items={[
          <>
            Any <Kbd>Message</Kbd> button (lead page, client page, quote page) opens a compose dialog — pick Email
            or SMS, the recipient is pre-filled, write your own subject and body.
          </>,
          "Every send is logged to that lead's Comms tab automatically, whichever channel you used.",
          "If you're about to send the exact same message again, a warning shows first — how long ago it last went, and how many times — before you can send anyway.",
        ]}
      />
      <Note tone="info">
        This is for one-off, personal messages. The 13 automatic emails in the table below fire on their own —
        you don&apos;t need to send those manually.
      </Note>
    </Section>
  );
}
