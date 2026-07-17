import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertMediaObjectKey,
  createMediaStore,
  parseMediaStorageDriver,
} from "@/lib/storage/media-store";
import { createSupabaseMediaStore } from "@/lib/storage/supabase-media-store";

function providerClient() {
  const upload = vi.fn();
  const info = vi.fn();
  const createSignedUrl = vi.fn();
  const remove = vi.fn();
  const from = vi.fn(() => ({ upload, info, createSignedUrl, remove }));
  return {
    client: { storage: { from } } as never,
    from,
    upload,
    info,
    createSignedUrl,
    remove,
  };
}

describe("AI media storage seam", () => {
  beforeEach(() => vi.clearAllMocks());

  it("defaults to Supabase and rejects unknown drivers", () => {
    expect(parseMediaStorageDriver(undefined)).toBe("supabase");
    expect(parseMediaStorageDriver(" S3 ")).toBe("s3");
    expect(() => parseMediaStorageDriver("filesystem")).toThrow(/unsupported/i);
    // The s3 (R2) driver is wired now; without R2 config it fails fast with a
    // clear "required" error rather than the old "not installed" placeholder.
    expect(() =>
      createMediaStore({
        AI_MEDIA_STORAGE_DRIVER: "s3",
      }),
    ).toThrow(/required for R2/i);
  });

  it("rejects provider-specific or traversing object keys", () => {
    expect(assertMediaObjectKey("survey/media/source.mp4")).toBe(
      "survey/media/source.mp4",
    );
    for (const key of ["/absolute", "folder/../escape", "folder\\file", "folder/"]) {
      expect(() => assertMediaObjectKey(key)).toThrow(/invalid/i);
    }
  });

  it("builds a Supabase TUS target only from environment configuration", async () => {
    const provider = providerClient();
    const store = createSupabaseMediaStore({
      environment: {
        SUPABASE_URL: "https://database.example.test",
        AI_MEDIA_STORAGE_BUCKET: "private-media",
      },
      client: provider.client,
    });

    await expect(
      store.createUploadTarget({
        objectKey: "survey/media/source.mp4",
        contentType: "video/mp4",
        accessToken: "session-token",
      }),
    ).resolves.toEqual({
      protocol: "tus",
      objectKey: "survey/media/source.mp4",
      endpoint: "https://database.example.test/storage/v1/upload/resumable",
      headers: { Authorization: "Bearer session-token", "x-upsert": "true" },
      metadata: {
        bucketName: "private-media",
        objectName: "survey/media/source.mp4",
        contentType: "video/mp4",
      },
      chunkSizeBytes: 6 * 1024 * 1024,
    });
  });

  it("uses an explicitly configured storage endpoint", async () => {
    const provider = providerClient();
    const store = createSupabaseMediaStore({
      environment: {
        AI_MEDIA_STORAGE_ENDPOINT: "https://storage.example.test/custom/",
      },
      client: provider.client,
    });

    const target = await store.createUploadTarget({
        objectKey: "survey/media/source.mp4",
        contentType: "video/mp4",
        accessToken: "token",
      });
    expect(target.protocol).toBe("tus");
    if (target.protocol !== "tus") throw new Error("Expected TUS target");
    expect(target.endpoint).toBe("https://storage.example.test/custom/upload/resumable");
  });

  it("centralises put, metadata, signed-get and delete calls", async () => {
    const provider = providerClient();
    provider.upload.mockResolvedValue({ data: {}, error: null });
    provider.info.mockResolvedValue({
      data: {
        metadata: { size: 42, mimetype: "image/jpeg", eTag: "etag-1" },
        updated_at: "2026-07-11T12:00:00Z",
      },
      error: null,
    });
    provider.createSignedUrl.mockResolvedValue({
      data: { signedUrl: "https://signed.example.test/object" },
      error: null,
    });
    provider.remove.mockResolvedValue({ data: [], error: null });
    const store = createSupabaseMediaStore({
      environment: { SUPABASE_URL: "https://database.example.test" },
      client: provider.client,
    });

    await expect(
      store.putObject({
        objectKey: "survey/media/frames/0001.jpg",
        body: new ArrayBuffer(1),
        contentType: "image/jpeg",
      }),
    ).resolves.toEqual({
      bytes: 42,
      contentType: "image/jpeg",
      etag: "etag-1",
      updatedAt: "2026-07-11T12:00:00Z",
    });
    await expect(
      store.createSignedGetUrl("survey/media/source.mp4", 300),
    ).resolves.toBe("https://signed.example.test/object");
    await store.deleteObjects([
      "survey/media/source.mp4",
      "survey/media/source.mp4",
      "survey/media/frames/0001.jpg",
    ]);

    expect(provider.from).toHaveBeenCalledWith("survey-media");
    expect(provider.remove).toHaveBeenCalledWith([
      "survey/media/source.mp4",
      "survey/media/frames/0001.jpg",
    ]);
  });

  it("normalises the current Supabase info response shape", async () => {
    const provider = providerClient();
    provider.info.mockResolvedValue({
      data: { size: 123, contentType: "video/mp4", etag: "etag-current", lastModified: "2026-07-11T23:32:45Z", metadata: null },
      error: null,
    });
    const store = createSupabaseMediaStore({ environment: { SUPABASE_URL: "https://database.example.test" }, client: provider.client });
    await expect(store.getObjectMetadata("survey/media/source.mp4")).resolves.toEqual({ bytes: 123, contentType: "video/mp4", etag: "etag-current", updatedAt: "2026-07-11T23:32:45Z" });
  });
});
