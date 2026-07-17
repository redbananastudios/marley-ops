import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  AI_MEDIA_BUCKET_DEFAULT,
  assertMediaObjectKey,
  type MediaObjectMetadata,
  type MediaStore,
  type MediaStoreEnvironment,
} from "@/lib/storage/media-store";
import { createAdminClient } from "@/lib/supabase/admin";

const SUPABASE_TUS_CHUNK_SIZE_BYTES = 6 * 1024 * 1024;

type StorageClient = Pick<SupabaseClient, "storage">;

interface CreateSupabaseMediaStoreOptions {
  environment?: MediaStoreEnvironment;
  client?: StorageClient;
  /** Logical bucket. Defaults to the AI-media env / survey-media. */
  bucket?: string;
}

function requireEnvironmentValue(value: string | undefined, name: string): string {
  const result = value?.trim();
  if (!result) throw new Error(`${name} is required for Supabase AI media storage`);
  return result;
}

function storageEndpoint(environment: MediaStoreEnvironment): string {
  const configured = environment.AI_MEDIA_STORAGE_ENDPOINT?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const supabaseUrl = requireEnvironmentValue(
    environment.SUPABASE_URL ?? environment.NEXT_PUBLIC_SUPABASE_URL,
    "SUPABASE_URL",
  );
  return `${supabaseUrl.replace(/\/+$/, "")}/storage/v1`;
}

function metadataFromProvider(value: {
  size?: number;
  contentType?: string;
  etag?: string;
  lastModified?: string;
  metadata?: { size?: number; mimetype?: string; eTag?: string } | null;
  updated_at?: string | null;
}): MediaObjectMetadata {
  return {
    bytes: value.metadata?.size ?? value.size ?? 0,
    contentType: value.contentType ?? value.metadata?.mimetype ?? null,
    etag: value.etag ?? value.metadata?.eTag ?? null,
    updatedAt: value.lastModified ?? value.updated_at ?? null,
  };
}

export function createSupabaseMediaStore({
  environment = process.env,
  client,
  bucket: bucketOverride,
}: CreateSupabaseMediaStoreOptions = {}): MediaStore {
  const bucket = bucketOverride?.trim() || environment.AI_MEDIA_STORAGE_BUCKET?.trim() || AI_MEDIA_BUCKET_DEFAULT;
  const endpoint = storageEndpoint(environment);
  const storageClient = client ?? createAdminClient();

  return {
    driver: "supabase",
    bucket,

    async createUploadTarget({ objectKey, contentType, accessToken }) {
      const key = assertMediaObjectKey(objectKey);
      const token = requireEnvironmentValue(accessToken, "accessToken");
      return {
        protocol: "tus",
        objectKey: key,
        endpoint: `${endpoint}/upload/resumable`,
        headers: {
          Authorization: `Bearer ${token}`,
          "x-upsert": "true",
        },
        metadata: {
          bucketName: bucket,
          objectName: key,
          contentType,
        },
        chunkSizeBytes: SUPABASE_TUS_CHUNK_SIZE_BYTES,
      };
    },

    async putObject({ objectKey, body, contentType, upsert = false }) {
      const key = assertMediaObjectKey(objectKey);
      const { error } = await storageClient.storage.from(bucket).upload(key, body, {
        contentType,
        upsert,
      });
      if (error) throw new Error(`AI media upload failed: ${error.message}`);
      return this.getObjectMetadata(key);
    },

    async getObjectMetadata(objectKey) {
      const key = assertMediaObjectKey(objectKey);
      const { data, error } = await storageClient.storage.from(bucket).info(key);
      if (error || !data) {
        throw new Error(`AI media metadata lookup failed: ${error?.message ?? "not found"}`);
      }
      return metadataFromProvider(data);
    },

    async getObject(objectKey) {
      const key = assertMediaObjectKey(objectKey);
      const { data, error } = await storageClient.storage.from(bucket).download(key);
      if (error || !data) {
        throw new Error(`AI media download failed: ${error?.message ?? "not found"}`);
      }
      return new Uint8Array(await data.arrayBuffer());
    },

    async createSignedGetUrl(objectKey, expiresInSeconds) {
      const key = assertMediaObjectKey(objectKey);
      if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1) {
        throw new Error("Signed URL expiry must be a positive integer");
      }
      const { data, error } = await storageClient.storage
        .from(bucket)
        .createSignedUrl(key, expiresInSeconds);
      if (error || !data?.signedUrl) {
        throw new Error(`AI media signed URL failed: ${error?.message ?? "no URL returned"}`);
      }
      return data.signedUrl;
    },

    async deleteObjects(objectKeys) {
      const keys = [...new Set(objectKeys.map(assertMediaObjectKey))];
      if (keys.length === 0) return;
      const { error } = await storageClient.storage.from(bucket).remove(keys);
      if (error) throw new Error(`AI media delete failed: ${error.message}`);
    },
  };
}
