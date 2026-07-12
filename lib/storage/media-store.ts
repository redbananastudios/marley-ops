import "server-only";

import { createSupabaseMediaStore } from "@/lib/storage/supabase-media-store";

export const AI_MEDIA_STORAGE_DRIVERS = ["supabase", "s3"] as const;
export type AiMediaStorageDriver = (typeof AI_MEDIA_STORAGE_DRIVERS)[number];

export const AI_MEDIA_BUCKET_DEFAULT = "survey-media";

export type MediaObjectBody = ArrayBuffer | Blob;

export interface TusMediaUploadTarget {
  protocol: "tus";
  objectKey: string;
  endpoint: string;
  headers: Record<string, string>;
  metadata: Record<string, string>;
  chunkSizeBytes?: number;
}

export interface MultipartMediaUploadTarget {
  protocol: "multipart";
  objectKey: string;
  partSizeBytes: number;
  parts: { partNumber: number; url: string; headers: Record<string, string> }[];
  complete: { url: string; headers: Record<string, string> };
}

export type MediaUploadTarget = TusMediaUploadTarget | MultipartMediaUploadTarget;

export interface MediaObjectMetadata {
  bytes: number;
  contentType: string | null;
  etag: string | null;
  updatedAt: string | null;
}

export interface MediaStore {
  readonly driver: AiMediaStorageDriver;
  readonly bucket: string;

  createUploadTarget(input: {
    objectKey: string;
    contentType: string;
    accessToken: string;
  }): Promise<MediaUploadTarget>;

  putObject(input: {
    objectKey: string;
    body: MediaObjectBody;
    contentType: string;
    upsert?: boolean;
  }): Promise<MediaObjectMetadata>;

  getObjectMetadata(objectKey: string): Promise<MediaObjectMetadata>;
  createSignedGetUrl(objectKey: string, expiresInSeconds: number): Promise<string>;
  deleteObjects(objectKeys: string[]): Promise<void>;
}

export interface MediaStoreEnvironment {
  [key: string]: string | undefined;
  AI_MEDIA_STORAGE_DRIVER?: string;
  AI_MEDIA_STORAGE_BUCKET?: string;
  AI_MEDIA_STORAGE_ENDPOINT?: string;
  SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
}

export function parseMediaStorageDriver(value: string | undefined): AiMediaStorageDriver {
  const driver = value?.trim().toLowerCase() || "supabase";
  if (driver === "supabase" || driver === "s3") return driver;
  throw new Error(`Unsupported AI media storage driver: ${driver}`);
}

export function assertMediaObjectKey(objectKey: string): string {
  const key = objectKey.trim();
  if (
    !key ||
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.includes("\\") ||
    key.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Invalid AI media object key");
  }
  return key;
}

export function createMediaStore(
  environment: MediaStoreEnvironment = process.env,
): MediaStore {
  const driver = parseMediaStorageDriver(environment.AI_MEDIA_STORAGE_DRIVER);

  if (driver === "supabase") {
    return createSupabaseMediaStore({ environment });
  }

  throw new Error(
    "AI media storage driver 's3' is not installed. Use 'supabase' until the Cloudflare R2 driver is configured.",
  );
}
