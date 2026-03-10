import { createWriteStream } from "fs";
import { unlink } from "fs/promises";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { readFile } from "fs/promises";
import { detectSilence } from "./silence";
import { EXCLUDED_SAMPLE_TYPES } from "./constants";
import type { StemFile, ProcessingResult } from "./types";

/**
 * Initialize Supabase client with service role key.
 */
export function getSupabaseClient(): SupabaseClient {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * Clean a raw stem name into a normalized stem type.
 * e.g. "Vocals (BS Roformer).mp3" → "vocals"
 */
function cleanStemName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/\.(mp3|wav|flac|m4a)$/i, "")
      .replace(/\s*\(.*?\)\s*/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "") || "unknown"
  );
}

/**
 * Download a file from a URL to a local path.
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} for ${url}`);
  }
  const body = res.body;
  if (!body) throw new Error(`No body in response for ${url}`);

  const nodeStream = Readable.fromWeb(body as any);
  const fileStream = createWriteStream(destPath);
  await pipeline(nodeStream, fileStream);
}

/**
 * Process all stems: download, detect silence, upload to Supabase Storage,
 * create sample records for non-silent + non-excluded stems.
 */
export async function processAndStoreStems(
  supabase: SupabaseClient,
  beatId: string,
  stemFiles: StemFile[]
): Promise<ProcessingResult> {
  const storedStems: Record<string, string> = {};
  let samplesCreated = 0;
  let samplesSkipped = 0;

  for (const { name, url } of stemFiles) {
    const stemType = cleanStemName(name);
    const tmpPath = `/tmp/${beatId}_${stemType}.mp3`;

    try {
      // 1. Download stem to /tmp
      console.log(`Downloading ${stemType} from ${url.slice(0, 80)}...`);
      await downloadFile(url, tmpPath);

      // 2. Read file for size check
      const fileData = await readFile(tmpPath);
      const fileSize = fileData.length;
      if (fileSize < 1000) {
        console.log(`Skipping ${stemType}: too small (${fileSize} bytes)`);
        samplesSkipped++;
        continue;
      }

      // 3. Run ffmpeg silence detection
      const { isSilent, meanVolume } = await detectSilence(tmpPath);
      console.log(
        `Stem ${stemType}: ${fileSize}B, meanVol=${meanVolume.toFixed(1)}dB, silent=${isSilent}`
      );

      // 4. Upload to Supabase Storage (always upload, even silent — keep full stems set)
      const storagePath = `beats/${beatId}/stems/${stemType}.mp3`;
      const { error: uploadErr } = await supabase.storage
        .from("audio")
        .upload(storagePath, fileData, {
          contentType: "audio/mpeg",
          upsert: true,
        });
      if (uploadErr) {
        console.error(
          `Storage upload error ${stemType}: ${uploadErr.message}`
        );
      }

      const { data: publicUrlData } = supabase.storage
        .from("audio")
        .getPublicUrl(storagePath);
      const publicUrl = publicUrlData?.publicUrl || url;
      storedStems[stemType] = publicUrl;

      // 5. Create sample record (skip silent + excluded types)
      if (isSilent || EXCLUDED_SAMPLE_TYPES.has(stemType)) {
        const reason = EXCLUDED_SAMPLE_TYPES.has(stemType)
          ? "excluded"
          : "silent";
        console.log(`Skipping sample for ${stemType}: ${reason}`);
        samplesSkipped++;
        continue;
      }

      const { error: sampleErr } = await supabase.from("samples").upsert(
        {
          beat_id: beatId,
          stem_type: stemType,
          audio_url: publicUrl,
          file_size: fileSize,
          audio_amplitude: fileSize,
          storage_migrated: true,
        },
        { onConflict: "beat_id,stem_type" }
      );
      if (sampleErr) {
        console.error(
          `Sample insert error ${stemType}: ${sampleErr.message}`
        );
      } else {
        samplesCreated++;
      }
    } catch (stemErr) {
      console.warn(
        `Stem processing error for ${name}: ${(stemErr as Error).message}`
      );
    } finally {
      // 6. Clean up temp file
      try {
        await unlink(tmpPath);
      } catch {
        /* file may not exist if download failed */
      }
    }
  }

  return { storedStems, samplesCreated, samplesSkipped };
}
