// supabase/functions/_shared/r2.ts
// Shared Cloudflare R2 upload/delete/URL helpers for Edge Functions.
// Uses the S3-compatible API via @aws-sdk/client-s3.

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "https://esm.sh/@aws-sdk/client-s3@3.264.0";

// ─── Singleton S3 client (reused across invocations) ─────────────────────
let _client: S3Client | null = null;

function getClient(): S3Client {
  if (_client) return _client;

  const accountId = Deno.env.get("R2_ACCOUNT_ID");
  const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID");
  const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY");

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 credentials not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)");
  }

  _client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return _client;
}

function getBucket(): string {
  const bucket = Deno.env.get("R2_BUCKET_NAME");
  if (!bucket) throw new Error("R2_BUCKET_NAME not configured");
  return bucket;
}

// ─── Public helpers ──────────────────────────────────────────────────────

/**
 * Upload a file to R2.
 * @param path  Object key, e.g. "beats/{id}/track.mp3"
 * @param data  File contents as Uint8Array
 * @param contentType  MIME type, e.g. "audio/mpeg"
 */
export async function r2Upload(
  path: string,
  data: Uint8Array,
  contentType: string,
): Promise<void> {
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: path,
      Body: data,
      ContentType: contentType,
    }),
  );
}

/**
 * Returns the public URL for an R2 object via the custom domain.
 * Zero network calls — pure string concatenation.
 * @param path  Object key, e.g. "beats/{id}/track.mp3"
 */
export function r2PublicUrl(path: string): string {
  const base = Deno.env.get("R2_PUBLIC_URL") || "https://cdn.beatclaw.com";
  return `${base}/${path}`;
}

/**
 * Delete an object from R2.
 * @param path  Object key to delete
 */
export async function r2Delete(path: string): Promise<void> {
  const client = getClient();
  await client.send(
    new DeleteObjectCommand({
      Bucket: getBucket(),
      Key: path,
    }),
  );
}
