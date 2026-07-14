import { Section } from "@/components/manual/manual-ui";
import { JobFlowDiagram } from "@/components/manual/job-flow-diagram";

export function JobFlowSection() {
  return (
    <Section id="how-a-job-flows" eyebrow="Overview" title="How a job flows">
      <p className="text-sm text-mist-500">
        Every job moves through the same pipeline, whether it starts as a website enquiry, a phone call, or a
        walk-in. The panel is built around these stages — most pages are just a view onto one part of this line.
      </p>
      <JobFlowDiagram />
    </Section>
  );
}
