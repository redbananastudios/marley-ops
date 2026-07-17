import "server-only";

import { createSupabaseMediaStore } from "@/lib/storage/supabase-media-store";
import { createS3MediaStore } from "@/lib/storage/s3-media-store";

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

/** Single presigned PUT straight to object storage (R2/S3). Simplest upload
 *  path: the browser PUTs the whole file to `url` sending exactly `headers`
 *  (the signed content-type). No resumability — a dropped upload restarts. */
export interface PresignedPutMediaUploadTarget {
  protocol: "put";
  objectKey: string;
  url: string;
  headers: Record<string, string>;
}

export type MediaUploadTarget =
  | TusMediaUploadTarget
  | MultipartMediaUploadTarget
  | PresignedPutMediaUploadTarget;

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
  // Cloudflare R2 connection (shared across every logical bucket — each logical
  // bucket is a key prefix inside the one R2 bucket).
  MARLEY_R2_ENDPOINT?: string;
  MARLEY_R2_BUCKET?: string;
  MARLEY_R2_ACCESS_KEY_ID?: string;
  MARLEY_R2_SECRET_ACCESS_KEY?: string;
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
  options: { bucket?: string } = {},
): MediaStore {
  const driver = parseMediaStorageDriver(environment.AI_MEDIA_STORAGE_DRIVER);

  // `bucket` selects the LOGICAL bucket (survey-media, job-media, ...). Both
  // drivers share one backend (one Supabase instance / one R2 bucket), so the
  // logical name is a key prefix, not a separate store. Same driver for all.
  if (driver === "supabase") {
    return createSupabaseMediaStore({ environment, bucket: options.bucket });
  }

  return createS3MediaStore({ environment, bucket: options.bucket });
}
