"use client";

import { useEffect } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

interface SurveyState {
  rooms: { id: string; status: string; updated_at: string }[];
  media: { id: string; status: string; updated_at: string }[];
}

async function fetchSurveyState(surveyId: string): Promise<SurveyState> {
  const response = await fetch(`/api/ai-surveys/state?surveyId=${encodeURIComponent(surveyId)}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Could not refresh AI survey state");
  return response.json() as Promise<SurveyState>;
}

function Poller({ surveyId, enabled }: { surveyId: string; enabled: boolean }) {
  const router = useRouter();
  const query = useQuery({
    queryKey: ["ai-survey-state", surveyId],
    queryFn: () => fetchSurveyState(surveyId),
    enabled,
    refetchInterval: enabled ? 5_000 : false,
    refetchIntervalInBackground: false,
  });
  useEffect(() => {
    if (query.dataUpdatedAt) router.refresh();
  }, [query.dataUpdatedAt, router]);
  return null;
}

export function SurveyStatePoller(props: { surveyId: string; enabled: boolean }) {
  return <QueryClientProvider client={queryClient}><Poller {...props} /></QueryClientProvider>;
}
