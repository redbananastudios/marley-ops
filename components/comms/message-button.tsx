"use client";

import { MessageSquare } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CommsDialog } from "@/components/comms/comms-dialog";

export function MessageButton({
  leadId,
  clientId,
  defaultEmail,
  defaultPhone,
}: {
  leadId?: string;
  clientId?: string;
  defaultEmail?: string;
  defaultPhone?: string;
}) {
  return (
    <CommsDialog
      leadId={leadId}
      clientId={clientId}
      defaultEmail={defaultEmail}
      defaultPhone={defaultPhone}
      trigger={
        <Button variant="outline">
          <MessageSquare strokeWidth={1.75} />
          Message
        </Button>
      }
    />
  );
}
