// supabase/functions/backfill-amplitude/index.ts
// ONE-TIME: Scans all samples missing audio_amplitude using Shannon entropy.
// Downloads 32KB from middle of each MP3, computes byte entropy.
// Silent MP3s have entropy ~6.7-7.3, real audio has ~7.7-8.0.
// Threshold: entropy < 7.5 = silent → audio_amplitude = 0.
// Call repeatedly until "done": true, then delete this function.
//
// GET /functions/v1/backfill-amplitude
// Optional: ?batch=50 (default 50, max 200)
// Optional: ?dry_run=true (log results without updating DB)
// Auth: Bearer token (service_role key) in Authorization header

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function shannonEntropy(buf: Uint8Array): number {
  const freq = new Array(256).fill(0);
  for (let i = 0; i < buf.length; i++) freq[buf[i]]++;
  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    if (freq[i] === 0) continue;
    const p = freq[i] / buf.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
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
    const batchSize = Math.min(parseInt(url.searchParams.get("batch") || "50", 10), 200);
    const dryRun = url.searchParams.get("dry_run") === "true";
    const SILENCE_ENTROPY = 7.5; // Silent < 7.5, real audio > 7.5

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

    // Fetch samples that haven't been scanned yet
    const { data: samples, error: fetchErr } = await supabase
      .from("samples")
      .select("id, stem_type, audio_url, beat_id, file_size")
      .is("audio_amplitude", null)
      .not("audio_url", "is", null)
      .limit(batchSize);

    if (fetchErr) throw fetchErr;
    if (!samples || samples.length === 0) {
      return new Response(
        JSON.stringify({ done: true, message: "No more samples to scan", scanned: 0, silent: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const results: { id: string; stem_type: string; beat_id: string; file_size: number; entropy: number; silent: boolean }[] = [];
    let totalScanned = 0;
    let totalSilent = 0;
    let totalErrors = 0;

    for (const sample of samples) {
      try {
        // Step 1: Get file size if missing
        let fileSize = sample.file_size || 0;
        if (fileSize === 0) {
          const headRes = await fetch(sample.audio_url, { method: "HEAD" });
          fileSize = parseInt(headRes.headers.get("content-length") || "0", 10);
        }

        if (fileSize < 1000) {
          if (!dryRun) {
            await supabase.from("samples").update({ audio_amplitude: 0, file_size: fileSize }).eq("id", sample.id);
          }
          results.push({ id: sample.id, stem_type: sample.stem_type, beat_id: sample.beat_id, file_size: fileSize, entropy: 0, silent: true });
          totalSilent++;
          totalScanned++;
          continue;
        }

        // Step 2: Download 32KB from middle of file
        const midpoint = Math.floor(fileSize / 2);
        const rangeStart = Math.max(0, midpoint - 16384);
        const rangeEnd = Math.min(fileSize - 1, midpoint + 16383);

        const partialRes = await fetch(sample.audio_url, {
          headers: { Range: `bytes=${rangeStart}-${rangeEnd}` },
        });
        const buf = new Uint8Array(await partialRes.arrayBuffer());

        // Step 3: Compute Shannon entropy
        const entropy = shannonEntropy(buf);
        const isSilent = entropy < SILENCE_ENTROPY;
        // Store 0 for silent, file_size for real audio (> 25 passes view filter)
        const amplitude = isSilent ? 0 : fileSize;

        if (!dryRun) {
          await supabase.from("samples").update({ audio_amplitude: amplitude, file_size: fileSize }).eq("id", sample.id);
        }

        results.push({
          id: sample.id,
          stem_type: sample.stem_type,
          beat_id: sample.beat_id,
          file_size: fileSize,
          entropy: parseFloat(entropy.toFixed(3)),
          silent: isSilent,
        });
        if (isSilent) totalSilent++;
        totalScanned++;
      } catch (err) {
        console.error(`Error scanning sample ${sample.id} (${sample.stem_type}):`, (err as Error).message);
        if (!dryRun) {
          await supabase.from("samples").update({ audio_amplitude: -1 }).eq("id", sample.id);
        }
        totalErrors++;
        totalScanned++;
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
