import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { AddLeadForm } from "./add-lead-form";

export const dynamic = "force-dynamic";

export default function NewLeadPage() {
  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Pipeline" title="Add lead" />
      <Card className="max-w-2xl p-6 md:p-8">
        <AddLeadForm />
      </Card>
    </main>
  );
}
