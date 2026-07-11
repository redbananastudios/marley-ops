import "server-only";

import { createGoogle } from "@ai-sdk/google";
import { generateText, Output, uploadFile } from "ai";
import type { z } from "zod";

import type { AiModelId } from "@/lib/ai/budget";

interface GeminiEnvironment {
  [key: string]: string | undefined;
  GEMINI_API_KEY?: string;
  GEMINI_API_BASE_URL?: string;
}

interface AnalyseGeminiMediaInput<Schema extends z.ZodType> {
  bytes: Uint8Array;
  mime: string;
  model: AiModelId;
  prompt: string;
  schema: Schema;
  displayName: string;
  environment?: GeminiEnvironment;
}

export interface GeminiMediaAnalysis<OutputType> {
  output: OutputType;
  inputTokens: number;
  outputTokens: number;
  providerFileName: string | null;
  providerFileDeleted: boolean;
}

function required(value: string | undefined, name: string): string {
  const result = value?.trim();
  if (!result) throw new Error(`${name} is required for Gemini analysis`);
  return result;
}

async function deleteProviderFile(input: {
  baseUrl: string;
  apiKey: string;
  fileName: string | null;
}): Promise<boolean> {
  if (!input.fileName) return false;
  try {
    const response = await fetch(
      `${input.baseUrl.replace(/\/+$/, "")}/${input.fileName.replace(/^\/+/, "")}`,
      {
        method: "DELETE",
        headers: { "x-goog-api-key": input.apiKey },
        signal: AbortSignal.timeout(30_000),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

export async function analyseGeminiMedia<Schema extends z.ZodType>(
  input: AnalyseGeminiMediaInput<Schema>,
): Promise<GeminiMediaAnalysis<z.infer<Schema>>> {
  const environment = input.environment ?? process.env;
  const apiKey = required(environment.GEMINI_API_KEY, "GEMINI_API_KEY");
  const baseUrl = required(environment.GEMINI_API_BASE_URL, "GEMINI_API_BASE_URL");
  const google = createGoogle({ apiKey, baseURL: baseUrl });
  const uploaded = await uploadFile({
    api: google,
    data: input.bytes,
    mediaType: input.mime,
    providerOptions: {
      google: { displayName: input.displayName, pollIntervalMs: 2_000, pollTimeoutMs: 600_000 },
    },
  });
  const providerFileName =
    typeof uploaded.providerMetadata?.google?.name === "string"
      ? uploaded.providerMetadata.google.name
      : null;

  try {
    const result = await generateText({
      model: google(input.model),
      output: Output.object({ schema: input.schema }),
      messages: [
        {
          role: "user",
          content: [
            { type: "file", data: uploaded.providerReference, mediaType: input.mime },
            { type: "text", text: input.prompt },
          ],
        },
      ],
      maxRetries: 1,
      timeout: { totalMs: 600_000 },
    });
    const providerFileDeleted = await deleteProviderFile({ baseUrl, apiKey, fileName: providerFileName });
    return {
      output: result.output as z.infer<Schema>,
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      providerFileName,
      providerFileDeleted,
    };
  } catch (error) {
    await deleteProviderFile({ baseUrl, apiKey, fileName: providerFileName });
    throw error;
  }
}
