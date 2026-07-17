import "server-only";

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  AI_MEDIA_BUCKET_DEFAULT,
  assertMediaObjectKey,
  type MediaObjectBody,
  type MediaObjectMetadata,
  type MediaStore,
  type MediaStoreEnvironment,
} from "@/lib/storage/media-store";

// How long a client has to start a presigned upload after we mint the target.
const UPLOAD_URL_TTL_SECONDS = 60 * 30;
// DeleteObjects accepts at most 1000 keys per request.
const DELETE_BATCH = 1000;

interface CreateS3MediaStoreOptions {
  environment?: MediaStoreEnvironment;
  /** Injectable for tests; production builds one from the R2 env. */
  client?: Pick<S3Client, "send">;
}

function required(value: string | undefined, name: string): string {
  const result = value?.trim();
  if (!result) throw new Error(`${name} is required for R2 (S3) media storage`);
  return result;
}

async function bodyToBytes(body: MediaObjectBody): Promise<Uint8Array> {
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  return new Uint8Array(body);
}

/**
 * Cloudflare R2 media store (S3 API). One R2 bucket holds every logical bucket
 * as a key PREFIX, so the paths persisted in the DB ("{surveyId}/{mediaId}/
 * source.mp4") stay valid unchanged — the prefix is added on the way to R2 and
 * never stored. Object access is private; reads are short-lived presigned URLs
 * minted per request, exactly like the Supabase driver it replaces.
 */
export function createS3MediaStore({
  environment = process.env,
  client,
}: CreateS3MediaStoreOptions = {}): MediaStore {
  const prefix = (environment.AI_MEDIA_STORAGE_BUCKET?.trim() || AI_MEDIA_BUCKET_DEFAULT).replace(
    /\/+$/,
    "",
  );
  const r2Bucket = required(environment.MARLEY_R2_BUCKET, "MARLEY_R2_BUCKET");
  const endpoint = required(
    environment.MARLEY_R2_ENDPOINT ?? environment.AI_MEDIA_STORAGE_ENDPOINT,
    "MARLEY_R2_ENDPOINT",
  );
  const accessKeyId = required(environment.MARLEY_R2_ACCESS_KEY_ID, "MARLEY_R2_ACCESS_KEY_ID");
  const secretAccessKey = required(
    environment.MARLEY_R2_SECRET_ACCESS_KEY,
    "MARLEY_R2_SECRET_ACCESS_KEY",
  );

  const s3 =
    client ??
    new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
  // getSignedUrl needs a real S3Client (it reads the signer config), so presign
  // through a dedicated instance even when a fake `send` client is injected.
  const signer =
    client == null
      ? (s3 as S3Client)
      : new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } });

  const toR2Key = (objectKey: string) => `${prefix}/${assertMediaObjectKey(objectKey)}`;

  async function objectExists(key: string): Promise<boolean> {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: r2Bucket, Key: key }));
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number }; name?: string });
      if (status.name === "NotFound" || status.$metadata?.httpStatusCode === 404) return false;
      throw error;
    }
  }

  return {
    driver: "s3",
    // Report the logical bucket (prefix) for parity with the Supabase driver.
    bucket: prefix,

    async createUploadTarget({ objectKey, contentType }) {
      const key = toR2Key(objectKey);
      const url = await getSignedUrl(
        signer,
        new PutObjectCommand({ Bucket: r2Bucket, Key: key, ContentType: contentType }),
        { expiresIn: UPLOAD_URL_TTL_SECONDS },
      );
      return {
        protocol: "put",
        objectKey: assertMediaObjectKey(objectKey),
        url,
        // R2 rejects the PUT with a signature mismatch unless the client sends
        // exactly the content-type we signed.
        headers: { "content-type": contentType },
      };
    },

    async putObject({ objectKey, body, contentType, upsert = false }) {
      const key = toR2Key(objectKey);
      if (!upsert && (await objectExists(key))) {
        throw new Error("AI media upload failed: object already exists");
      }
      await s3.send(
        new PutObjectCommand({
          Bucket: r2Bucket,
          Key: key,
          Body: await bodyToBytes(body),
          ContentType: contentType,
        }),
      );
      return this.getObjectMetadata(objectKey);
    },

    async getObjectMetadata(objectKey): Promise<MediaObjectMetadata> {
      const key = toR2Key(objectKey);
      const head = await s3.send(new HeadObjectCommand({ Bucket: r2Bucket, Key: key }));
      return {
        bytes: head.ContentLength ?? 0,
        contentType: head.ContentType ?? null,
        etag: head.ETag ?? null,
        updatedAt: head.LastModified ? head.LastModified.toISOString() : null,
      };
    },

    async createSignedGetUrl(objectKey, expiresInSeconds) {
      if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1) {
        throw new Error("Signed URL expiry must be a positive integer");
      }
      const key = toR2Key(objectKey);
      return getSignedUrl(signer, new GetObjectCommand({ Bucket: r2Bucket, Key: key }), {
        expiresIn: expiresInSeconds,
      });
    },

    async deleteObjects(objectKeys) {
      const keys = [...new Set(objectKeys.map(toR2Key))];
      for (let i = 0; i < keys.length; i += DELETE_BATCH) {
        const batch = keys.slice(i, i + DELETE_BATCH);
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: r2Bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
      }
    },
  };
}
