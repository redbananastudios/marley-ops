import "server-only";

import { createGoogle } from "@ai-sdk/google";
import { generateText, Output } from "ai";
import type { z } from "zod";

import type { AiModelId } from "@/lib/ai/budget";

interface GeminiEnvironment {
  [key: string]: string | undefined;
  GEMINI_API_KEY?: string;
  GEMINI_API_BASE_URL?: string;
}

interface AnalyseGeminiMediaInput<Schema extends z.ZodType> {
  sourceUrl: string;
  bytes: number;
  mime: string;
  model: AiModelId;
  prompt: string;
  schema: Schema;
  displayName: string;
  onFileUploaded?: (fileName: string) => Promise<void>;
  environment?: GeminiEnvironment;
}

interface ProviderFile { name: string; uri: string; state: string; mimeType: string }

const TRANSFER_CHUNK_BYTES = 16 * 1024 * 1024;

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

export async function deleteGeminiProviderFile(
  fileName: string,
  environment: GeminiEnvironment = process.env,
): Promise<boolean> {
  return deleteProviderFile({
    fileName,
    apiKey: required(environment.GEMINI_API_KEY, "GEMINI_API_KEY"),
    baseUrl: required(environment.GEMINI_API_BASE_URL, "GEMINI_API_BASE_URL"),
  });
}

async function checkedFetch(url: string, init: RequestInit, operation: string): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${operation} failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  return response;
}

async function uploadProviderFile(input: {
  sourceUrl: string; bytes: number; mime: string; displayName: string;
  baseUrl: string; apiKey: string; onFileUploaded?: (fileName: string) => Promise<void>;
}): Promise<ProviderFile> {
  const apiOrigin = input.baseUrl.replace(/\/+$/, "").replace(/\/v1beta$/, "");
  const start = await checkedFetch(`${apiOrigin}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": input.apiKey,
      "content-type": "application/json",
      "x-goog-upload-protocol": "resumable",
      "x-goog-upload-command": "start",
      "x-goog-upload-header-content-length": String(input.bytes),
      "x-goog-upload-header-content-type": input.mime,
    },
    body: JSON.stringify({ file: { display_name: input.displayName } }),
    signal: AbortSignal.timeout(60_000),
  }, "Gemini upload start");
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini upload start returned no resumable URL");

  let file: ProviderFile | null = null;
  for (let offset = 0; offset < input.bytes; offset += TRANSFER_CHUNK_BYTES) {
    const end = Math.min(input.bytes, offset + TRANSFER_CHUNK_BYTES) - 1;
    const source = await checkedFetch(input.sourceUrl, {
      headers: { Range: `bytes=${offset}-${end}` },
      signal: AbortSignal.timeout(120_000),
    }, "Media range download");
    const body = await source.arrayBuffer();
    const final = end + 1 === input.bytes;
    const uploaded = await checkedFetch(uploadUrl, {
      method: "POST",
      headers: {
        "content-type": input.mime,
        "x-goog-upload-offset": String(offset),
        "x-goog-upload-command": final ? "upload, finalize" : "upload",
      },
      body,
      signal: AbortSignal.timeout(120_000),
    }, "Gemini chunk upload");
    if (final) file = (await uploaded.json() as { file: ProviderFile }).file;
  }
  if (!file?.name || !file.uri) throw new Error("Gemini upload returned an incomplete file resource");
  let activeFile: ProviderFile = file;
  await input.onFileUploaded?.(activeFile.name);

  const deadline = Date.now() + 600_000;
  while (activeFile.state !== "ACTIVE") {
    if (activeFile.state === "FAILED") throw new Error("Gemini could not process the uploaded media");
    if (Date.now() >= deadline) throw new Error("Gemini file processing timed out");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    activeFile = await checkedFetch(`${input.baseUrl.replace(/\/+$/, "")}/${activeFile.name}`, {
      headers: { "x-goog-api-key": input.apiKey }, signal: AbortSignal.timeout(30_000),
    }, "Gemini file status").then((response) => response.json() as Promise<ProviderFile>);
  }
  return activeFile;
}

export async function analyseGeminiMedia<Schema extends z.ZodType>(
  input: AnalyseGeminiMediaInput<Schema>,
): Promise<GeminiMediaAnalysis<z.infer<Schema>>> {
  const environment = input.environment ?? process.env;
  const apiKey = required(environment.GEMINI_API_KEY, "GEMINI_API_KEY");
  const baseUrl = required(environment.GEMINI_API_BASE_URL, "GEMINI_API_BASE_URL");
  const google = createGoogle({ apiKey, baseURL: baseUrl });
  let providerFileName: string | null = null;

  try {
    const uploaded = await uploadProviderFile({
      sourceUrl: input.sourceUrl, bytes: input.bytes, mime: input.mime,
      displayName: input.displayName, baseUrl, apiKey,
      onFileUploaded: async (fileName) => {
        providerFileName = fileName;
        await input.onFileUploaded?.(fileName);
      },
    });
    const result = await generateText({
      model: google(input.model),
      output: Output.object({ schema: input.schema }),
      messages: [
        {
          role: "user",
          content: [
            { type: "file", data: { google: uploaded.uri }, mediaType: input.mime },
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
