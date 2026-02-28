// supabase/functions/backfill-amplitude/index.ts
// ONE-TIME: Scans all samples missing audio_amplitude using file-size comparison.
// For each beat, computes the median file size across all sibling stems.
// Stems with file_size < 50% of median are marked silent (audio_amplitude = 0).
// Call repeatedly until "done": true, then delete this function.
//
// GET /functions/v1/backfill-amplitude
// Optional: ?batch=10 (default 10 beats per call, max 50)
// Optional: ?dry_run=true (log results without updating DB)
// Auth: Bearer token (service_role key) in Authorization header

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const batchSize = Math.min(parseInt(url.searchParams.get("batch") || "10", 10), 50);
    const dryRun = url.searchParams.get("dry_run") === "true";

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

    // Find distinct beat_ids that still have unscanned samples
    const { data: unscannedBeats, error: beatErr } = await supabase
      .from("samples")
      .select("beat_id")
      .is("audio_amplitude", null)
      .not("audio_url", "is", null)
      .limit(500);

    if (beatErr) throw beatErr;
    if (!unscannedBeats || unscannedBeats.length === 0) {
      return new Response(
        JSON.stringify({ done: true, message: "No more samples to scan", beats_processed: 0, scanned: 0, silent: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Deduplicate beat_ids
    const beatIds = [...new Set(unscannedBeats.map((s: any) => s.beat_id))].slice(0, batchSize);

    const results: { id: string; stem_type: string; beat_id: string; file_size: number; median_size: number; silent: boolean }[] = [];
    let totalScanned = 0;
    let totalSilent = 0;
    let totalErrors = 0;

    for (const beatId of beatIds) {
      try {
        // Get ALL samples for this beat (including already-scanned ones for median calculation)
        const { data: beatSamples, error: samplesErr } = await supabase
          .from("samples")
          .select("id, stem_type, audio_url, file_size, audio_amplitude")
          .eq("beat_id", beatId);

        if (samplesErr || !beatSamples || beatSamples.length === 0) continue;

        // Step 1: Ensure all samples have file_size (HEAD request if missing)
        for (const sample of beatSamples) {
          if (sample.file_size == null && sample.audio_url) {
            try {
              const headRes = await fetch(sample.audio_url, { method: "HEAD" });
              sample.file_size = parseInt(headRes.headers.get("content-length") || "0", 10);
              if (!dryRun) {
                await supabase.from("samples").update({ file_size: sample.file_size }).eq("id", sample.id);
              }
            } catch {
              sample.file_size = 0;
            }
          }
        }

        // Step 2: Compute median file size across all stems for this beat
        const sizes = beatSamples.map((s: any) => s.file_size || 0).filter((s: number) => s > 0);
        const medianSize = median(sizes);
        const threshold = medianSize * 0.5;

        // Step 3: Mark each unscanned sample as silent or not
        for (const sample of beatSamples) {
          if (sample.audio_amplitude != null) continue; // already scanned

          const fileSize = sample.file_size || 0;
          const isSilent = fileSize < threshold || fileSize < 1000;
          const amplitude = isSilent ? 0 : fileSize; // store file_size as amplitude (non-zero = real audio)

          if (!dryRun) {
            await supabase.from("samples").update({ audio_amplitude: amplitude }).eq("id", sample.id);
          }

          results.push({
            id: sample.id,
            stem_type: sample.stem_type,
            beat_id: beatId as string,
            file_size: fileSize,
            median_size: medianSize,
            silent: isSilent,
          });
          if (isSilent) totalSilent++;
          totalScanned++;
        }
      } catch (err) {
        console.error(`Error processing beat ${beatId}:`, (err as Error).message);
        totalErrors++;
      }
    }

    // Check how many remain
    const { count: remaining } = await supabase
      .from("samples")
      .select("id", { count: "exact", head: true })
      .is("audio_amplitude", null);

    return new Response(
      JSON.stringify({
        done: (remaining || 0) === 0,
        beats_processed: beatIds.length,
        scanned: totalScanned,
        silent: totalSilent,
        errors: totalErrors,
        remaining: remaining || 0,
        dry_run: dryRun,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Backfill error:", (err as Error).message);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
