import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createS3MediaStore } from "@/lib/storage/s3-media-store";
import { createMediaStore } from "@/lib/storage/media-store";

const R2_ENV = {
  AI_MEDIA_STORAGE_DRIVER: "s3",
  AI_MEDIA_STORAGE_BUCKET: "survey-media",
  MARLEY_R2_ENDPOINT: "https://acct.eu.r2.cloudflarestorage.com",
  MARLEY_R2_BUCKET: "marley-ops",
  MARLEY_R2_ACCESS_KEY_ID: "test-key",
  MARLEY_R2_SECRET_ACCESS_KEY: "test-secret",
};

/** An S3 "NotFound" error shaped like the SDK's, for the upsert existence check. */
class NotFound extends Error {
  name = "NotFound";
  $metadata = { httpStatusCode: 404 };
}

/** Fake `send` client dispatching by command class name. */
function fakeClient(handlers: Record<string, (cmd: { input: Record<string, unknown> }) => unknown>) {
  const send = vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const handler = handlers[cmd.constructor.name];
    if (!handler) throw new Error(`unexpected command ${cmd.constructor.name}`);
    return handler(cmd);
  });
  return { client: { send } as never, send };
}

describe("R2 (S3) media store", () => {
  it("createMediaStore wires the s3 driver from config", () => {
    const store = createMediaStore(R2_ENV);
    expect(store.driver).toBe("s3");
    expect(store.bucket).toBe("survey-media");
  });

  it("fails fast when R2 config is missing", () => {
    expect(() => createS3MediaStore({ environment: { AI_MEDIA_STORAGE_DRIVER: "s3" } })).toThrow(
      /required for R2/i,
    );
  });

  it("mints a presigned PUT target that prefixes the logical bucket into the key", async () => {
    const store = createS3MediaStore({ environment: R2_ENV });
    const target = await store.createUploadTarget({
      objectKey: "sid/mid/source.mp4",
      contentType: "video/mp4",
      accessToken: "ignored-for-s3",
    });
    expect(target.protocol).toBe("put");
    if (target.protocol !== "put") throw new Error("expected a put target");
    // The DB keeps the un-prefixed key; only the R2 URL carries the prefix.
    expect(target.objectKey).toBe("sid/mid/source.mp4");
    expect(target.headers).toEqual({ "content-type": "video/mp4" });
    expect(target.url).toContain("survey-media/sid/mid/source.mp4");
    expect(target.url).toMatch(/X-Amz-Signature=/);
  });

  it("presigns a GET with the prefixed key and the requested expiry", async () => {
    const store = createS3MediaStore({ environment: R2_ENV });
    const url = await store.createSignedGetUrl("sid/mid/source.mp4", 300);
    expect(url).toContain("survey-media/sid/mid/source.mp4");
    expect(url).toMatch(/X-Amz-Expires=300/);
  });

  it("rejects a non-positive signed-URL expiry", async () => {
    const store = createS3MediaStore({ environment: R2_ENV });
    await expect(store.createSignedGetUrl("a/b.mp4", 0)).rejects.toThrow(/positive integer/i);
  });

  it("rejects traversing or absolute object keys", async () => {
    const store = createS3MediaStore({ environment: R2_ENV });
    for (const bad of ["/absolute", "a/../escape", "a\\b", "folder/"]) {
      await expect(
        store.createUploadTarget({ objectKey: bad, contentType: "x", accessToken: "" }),
      ).rejects.toThrow(/invalid/i);
    }
  });

  it("writes (upsert=false) after a not-found check, returning mapped metadata", async () => {
    let heads = 0;
    const { client, send } = fakeClient({
      HeadObjectCommand: () => {
        heads += 1;
        if (heads === 1) throw new NotFound("nope"); // existence check → absent
        return {
          ContentLength: 3,
          ContentType: "image/jpeg",
          ETag: '"e1"',
          LastModified: new Date("2026-07-17T00:00:00Z"),
        };
      },
      PutObjectCommand: () => ({}),
    });
    const store = createS3MediaStore({ environment: R2_ENV, client });
    await expect(
      store.putObject({
        objectKey: "sid/mid/f.jpg",
        body: new ArrayBuffer(3),
        contentType: "image/jpeg",
      }),
    ).resolves.toEqual({
      bytes: 3,
      contentType: "image/jpeg",
      etag: '"e1"',
      updatedAt: "2026-07-17T00:00:00.000Z",
    });
    const putCmd = send.mock.calls.map((c) => c[0]).find((c) => c.constructor.name === "PutObjectCommand");
    expect(putCmd?.input.Key).toBe("survey-media/sid/mid/f.jpg");
    expect(putCmd?.input.Bucket).toBe("marley-ops");
  });

  it("refuses to overwrite when upsert is false and the object already exists", async () => {
    const { client } = fakeClient({ HeadObjectCommand: () => ({ ContentLength: 1 }) });
    const store = createS3MediaStore({ environment: R2_ENV, client });
    await expect(
      store.putObject({ objectKey: "a/b.jpg", body: new ArrayBuffer(1), contentType: "image/jpeg" }),
    ).rejects.toThrow(/already exists/i);
  });

  it("maps HeadObject output to MediaObjectMetadata", async () => {
    const { client } = fakeClient({
      HeadObjectCommand: () => ({
        ContentLength: 100,
        ContentType: "video/mp4",
        ETag: '"abc"',
        LastModified: new Date("2026-01-02T03:04:05Z"),
      }),
    });
    const store = createS3MediaStore({ environment: R2_ENV, client });
    await expect(store.getObjectMetadata("a/b.mp4")).resolves.toEqual({
      bytes: 100,
      contentType: "video/mp4",
      etag: '"abc"',
      updatedAt: "2026-01-02T03:04:05.000Z",
    });
  });

  it("deletes prefixed keys, de-duplicated", async () => {
    const { client, send } = fakeClient({ DeleteObjectsCommand: () => ({}) });
    const store = createS3MediaStore({ environment: R2_ENV, client });
    await store.deleteObjects([
      "sid/mid/source.mp4",
      "sid/mid/source.mp4",
      "sid/mid/frames/0001.jpg",
    ]);
    const cmd = send.mock.calls[0][0];
    expect(cmd.input.Bucket).toBe("marley-ops");
    expect(cmd.input.Delete).toEqual({
      Objects: [
        { Key: "survey-media/sid/mid/source.mp4" },
        { Key: "survey-media/sid/mid/frames/0001.jpg" },
      ],
      Quiet: true,
    });
  });
});
