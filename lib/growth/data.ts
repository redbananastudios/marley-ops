import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { GrowthArtifactRow } from "./types";

export const GROWTH_BRAND = "marley-moves";

/**
 * Read one pushed Growth Suite artifact. Returns null when the i9 push has
 * never delivered that artifact type — pages must render an honest empty
 * state, never fabricate.
 */
export async function getGrowthArtifact<T>(
  sb: SupabaseClient<Database>,
  artifactType: string,
  brand: string = GROWTH_BRAND,
): Promise<{ payload: T; pushedAt: string; generatedAt: string | null } | null> {
  const { data, error } = await sb
    .from("growth_artifacts")
    .select("brand, artifact_type, generated_at, pushed_at, source_host, payload")
    .eq("brand", brand)
    .eq("artifact_type", artifactType)
    .maybeSingle<GrowthArtifactRow>();
  if (error || !data) return null;
  return { payload: data.payload as T, pushedAt: data.pushed_at, generatedAt: data.generated_at };
}
