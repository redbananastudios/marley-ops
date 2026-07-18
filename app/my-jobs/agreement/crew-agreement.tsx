"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ContractorAgreementSign } from "@/components/contractor/agreement-sign";

/** Client wrapper: after the crew member signs, thank them and send them on to
 *  build their invoice. */
export function CrewAgreement() {
  const router = useRouter();
  return (
    <ContractorAgreementSign
      onSigned={() => {
        toast.success("Thanks — you're all set to invoice.");
        router.replace("/my-jobs/pay");
        router.refresh();
      }}
    />
  );
}
