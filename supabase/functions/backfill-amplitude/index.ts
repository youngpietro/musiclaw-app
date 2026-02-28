// supabase/functions/backfill-amplitude/index.ts
// ONE-TIME: Scans all samples missing audio_amplitude,
// downloads 8KB from middle of each audio file, computes byte stddev,
// and updates the column. Silent stems (stddev < 5) get amplitude = 0.
// Call once, then delete this function.
//
// GET /functions/v1/backfill-amplitude?secret=YOUR_SERVICE_ROLE_KEY
// Optional: ?batch=50 (default 50, max 200)
// Optional: ?dry_run=true (log results without updating DB)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // Auth: Bearer token is validated by Supabase gateway (service_role required)
    const url = new URL(req.url);
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const batchSize = Math.min(parseInt(url.searchParams.get("batch") || "50", 10), 200);
    const dryRun = url.searchParams.get("dry_run") === "true";

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      serviceKey
    );

    // Fetch samples that haven't been scanned yet
    const { data: samples, error: fetchErr } = await supabase
      .from("samples")
      .select("id, stem_type, audio_url, beat_id")
      .is("audio_amplitude", null)
      .not("audio_url", "is", null)
      .limit(batchSize);

    if (fetchErr) throw fetchErr;
    if (!samples || samples.length === 0) {
      return new Response(
        JSON.stringify({ done: true, message: "No more samples to scan", scanned: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const results: { id: string; stem_type: string; beat_id: string; amplitude: number; silent: boolean }[] = [];
    let updated = 0;
    let silentCount = 0;
    let errorCount = 0;

    for (const sample of samples) {
      try {
        // Step 1: HEAD to get file size
        const headRes = await fetch(sample.audio_url, { method: "HEAD" });
        const contentLength = parseInt(headRes.headers.get("content-length") || "0", 10);

        if (contentLength < 1000) {
          // Tiny file — mark as silent
          if (!dryRun) {
            await supabase.from("samples").update({ audio_amplitude: 0, file_size: contentLength }).eq("id", sample.id);
          }
          results.push({ id: sample.id, stem_type: sample.stem_type, beat_id: sample.beat_id, amplitude: 0, silent: true });
          silentCount++;
          updated++;
          continue;
        }

        // Step 2: GET 8KB from middle of file
        const midpoint = Math.floor(contentLength / 2);
        const rangeStart = Math.max(0, midpoint - 4096);
        const rangeEnd = Math.min(contentLength - 1, midpoint + 4095);

        const partialRes = await fetch(sample.audio_url, {
          headers: { Range: `bytes=${rangeStart}-${rangeEnd}` },
        });
        const buf = new Uint8Array(await partialRes.arrayBuffer());

        // Compute byte standard deviation
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i];
        const mean = sum / buf.length;
        let variance = 0;
        for (let i = 0; i < buf.length; i++) variance += (buf[i] - mean) ** 2;
        const stddev = Math.sqrt(variance / buf.length);

        const isSilent = stddev < 25;
        // Store 0 for silent stems so the view filter catches them
        const amplitude = isSilent ? 0 : parseFloat(stddev.toFixed(2));

        if (!dryRun) {
          await supabase
            .from("samples")
            .update({ audio_amplitude: amplitude, file_size: contentLength })
            .eq("id", sample.id);
        }

        results.push({ id: sample.id, stem_type: sample.stem_type, beat_id: sample.beat_id, amplitude, silent: isSilent });
        if (isSilent) silentCount++;
        updated++;
      } catch (err) {
        console.error(`Error scanning sample ${sample.id} (${sample.stem_type}):`, (err as Error).message);
        // Mark as scanned with amplitude -1 so we don't retry forever
        if (!dryRun) {
          await supabase.from("samples").update({ audio_amplitude: -1 }).eq("id", sample.id);
        }
        errorCount++;
        updated++;
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
        scanned: updated,
        silent: silentCount,
        errors: errorCount,
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
