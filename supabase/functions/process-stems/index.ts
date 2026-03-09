// supabase/functions/process-stems/index.ts
// POST /functions/v1/process-stems
// Headers: Authorization: Bearer <agent_api_token>
// Body: { beat_id, suno_api_key?, suno_cookie? }
// Triggers WAV conversion + stem splitting for Suno-generated beats.
// Supports sunoapi.org (suno_api_key) and self-hosted (suno_cookie).
// Uploaded beats (generation_source='upload') should include stems via upload-beat.
// SECURITY: Bearer auth, rate limiting, beat ownership validation

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Stem types that should NOT become purchasable samples.
// "instrumental" = full beat minus vocals (would undercut beat sales)
// "vocals" / "vocal" / "backing_vocals" / "lead_vocals" = empty on instrumental beats
const EXCLUDED_SAMPLE_TYPES = new Set([
  "instrumental", "vocals", "vocal", "backing_vocals", "lead_vocals",
]);

const ALLOWED_ORIGINS = [
  "https://musiclaw.app",
  "https://www.musiclaw.app",
  "https://musiclaw-app.vercel.app",
];

function getCorsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ─── AUTH ──────────────────────────────────────────────────────────
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization: Bearer <api_token>" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const tokenBytes = new TextEncoder().encode(token);
    const hashBuffer = await crypto.subtle.digest("SHA-256", tokenBytes);
    const tokenHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

    let { data: agent } = await supabase.from("agents").select("id, handle, suno_self_hosted_url, g_credits, owner_email, lalal_api_key").eq("api_token_hash", tokenHash).single();
    if (!agent) {
      const { data: fallback } = await supabase.from("agents").select("id, handle, suno_self_hosted_url, g_credits, owner_email, lalal_api_key").eq("api_token", token).single();
      agent = fallback;
    }

    if (!agent) {
      return new Response(
        JSON.stringify({ error: "Invalid API token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── RATE LIMITING: max 20 per hour per agent ───────────────────
    const { data: recentCalls } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "process_stems")
      .eq("identifier", agent.id)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentCalls && recentCalls.length >= 20) {
      return new Response(
        JSON.stringify({ error: "Rate limit: max 20 process-stems calls per hour." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("rate_limits").insert({
      action: "process_stems",
      identifier: agent.id,
    });

    // ─── VALIDATE INPUT ─────────────────────────────────────────────
    const body = await req.json();
    const { beat_id, suno_api_key, suno_cookie: inlineCookie, stem_clip_ids: importClipIds } = body;

    if (!beat_id) {
      return new Response(
        JSON.stringify({ error: "beat_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── LOOK UP BEAT (must belong to this agent) ───────────────────
    const { data: beat } = await supabase
      .from("beats")
      .select("id, title, suno_id, task_id, status, agent_id, wav_status, stems_status, stems, generation_source")
      .eq("id", beat_id)
      .eq("agent_id", agent.id)
      .single();

    if (!beat) {
      return new Response(
        JSON.stringify({ error: "Beat not found or does not belong to you" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (beat.status !== "complete") {
      return new Response(
        JSON.stringify({ error: "Beat is not yet complete. Wait for generation to finish, then call this endpoint." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── DETERMINE GENERATION SOURCE ──────────────────────────────────
    const generationSource = beat.generation_source || "sunoapi";
    const useSelfHosted = generationSource === "selfhosted";

    // Uploaded beats don't support Suno stem splitting — stems should be uploaded directly
    if (generationSource === "upload") {
      return new Response(
        JSON.stringify({
          error: "Uploaded beats don't support Suno stem splitting. To add stems, use the upload-beat endpoint with a 'stems' object containing URLs for each stem (drums, bass, vocals, melody, other).",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!beat.suno_id) {
      return new Response(
        JSON.stringify({ error: "Beat has no Suno ID — cannot process WAV/stems." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // sunoapi.org beats need task_id ONLY when using sunoapi.org path (not LALAL.ai)
    if (!useSelfHosted && !beat.task_id && !agent.lalal_api_key) {
      return new Response(
        JSON.stringify({ error: "Beat has no generation task_id — cannot process WAV/stems via sunoapi.org." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── RESOLVE CREDENTIALS ─────────────────────────────────────────
    let effectiveCookie = inlineCookie || null;
    if (useSelfHosted && !effectiveCookie) {
      const { data: agentFull } = await supabase
        .from("agents").select("suno_cookie").eq("id", agent.id).single();
      effectiveCookie = agentFull?.suno_cookie || null;
    }
    // Fallback to centralized cookie env var (for G-Credit agents without their own cookie)
    if (useSelfHosted && !effectiveCookie) {
      effectiveCookie = Deno.env.get("SUNO_SELF_HOSTED_COOKIE") || null;
    }

    if (useSelfHosted && !effectiveCookie) {
      return new Response(
        JSON.stringify({ error: "suno_cookie is required for self-hosted beats. Pass it in the request or store it via update-agent-settings." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    // suno_api_key is only required for sunoapi.org beats WITHOUT a LALAL.ai key
    // (LALAL.ai handles stems directly, sunoapi.org key only needed for WAV + old split_stem path)
    if (!useSelfHosted && !suno_api_key && !agent.lalal_api_key) {
      return new Response(
        JSON.stringify({ error: "suno_api_key or lalal_api_key is required. Set your LALAL.ai key via update-agent-settings, or pass suno_api_key for sunoapi.org." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // If both are stuck in processing, allow retry (callbacks may have failed)
    if (beat.wav_status === "processing" && beat.stems_status === "processing") {
      console.log(`Re-triggering WAV/stems for beat ${beat.id} (both were stuck in processing state)`);
    }

    if (beat.wav_status === "complete" && beat.stems_status === "complete") {
      return new Response(
        JSON.stringify({
          message: "WAV and stems are already complete for this beat.",
          wav_status: beat.wav_status,
          stems_status: beat.stems_status,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // If either is "failed", allow retry
    console.log(`Process-stems for beat ${beat.id}: wav_status=${beat.wav_status}, stems_status=${beat.stems_status} — proceeding`);

    // ─── TRIGGER WAV + STEMS ────────────────────────────────────────
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const callbackSecret = Deno.env.get("SUNO_CALLBACK_SECRET");
    const selfHostedUrl = useSelfHosted
      ? (agent.suno_self_hosted_url || Deno.env.get("SUNO_SELF_HOSTED_URL"))
      : null;
    const useCentralized = useSelfHosted && !agent.suno_self_hosted_url && !!Deno.env.get("SUNO_SELF_HOSTED_URL");
    // callbackSecret only needed for sunoapi.org path (not LALAL.ai)
    if (!useSelfHosted && !callbackSecret && !agent.lalal_api_key) {
      console.error("SUNO_CALLBACK_SECRET not configured");
      return new Response(
        JSON.stringify({ error: "Server misconfigured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (useSelfHosted && !selfHostedUrl) {
      return new Response(
        JSON.stringify({ error: "No self-hosted Suno API URL configured. Set yours via update-agent-settings." }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const results: string[] = [];

    // ─── G-CREDIT DEDUCTION ────────────────────────────────────────────
    // Self-hosted beats now use LALAL.ai (agent pays directly) → no G-Credit for stems.
    // G-Credits are only charged for sunoapi.org stems if we re-enable that path.
    let gcreditDeducted = false;
    const shouldChargeGCredit = false; // LALAL.ai stems = agent-paid, no platform cost
    if (shouldChargeGCredit) {
      const creditOwnerEmail = agent.owner_email?.trim().toLowerCase();
      if (!creditOwnerEmail) {
        return new Response(
          JSON.stringify({ error: "Agent has no owner_email set. Register with an email first." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const { data: newBal, error: gcErr } = await supabase.rpc("deduct_owner_gcredits", {
        p_email: creditOwnerEmail, p_amount: 1,
      });
      if (gcErr) {
        // Get current balance for error message
        const { data: ownerCr } = await supabase.from("owner_gcredits").select("g_credits").eq("owner_email", creditOwnerEmail).single();
        return new Response(
          JSON.stringify({
            error: "Insufficient G-Credits. You need 1 G-Credit for stems on the centralized Suno API.",
            g_credits: ownerCr?.g_credits ?? 0,
            owner_email: creditOwnerEmail,
            buy: "POST /functions/v1/manage-gcredits with {\"action\":\"buy\"} — $5 = 50 G-Credits",
          }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      gcreditDeducted = true;
      await supabase.from("gcredit_usage").insert({
        agent_id: agent.id, action: "stems", credits_spent: 1, beat_id: beat.id,
      });
      console.log(`G-Credit deducted: 1 from owner ${creditOwnerEmail} via @${agent.handle} for stems (balance: ${newBal})`);
    }

    // ─── LALAL.AI vs SUNOAPI.ORG ROUTING ──────────────────────────────
    // If agent has a LALAL.ai key → use LALAL.ai for stems (any beat).
    // Otherwise, sunoapi.org beats fall back to sunoapi.org split_stem.
    const lalalKey = agent.lalal_api_key || null;
    const useLalal = !!lalalKey;

    if (useSelfHosted || useLalal) {
      // ─── WAV HANDLING ──────────────────────────────────────────────
      if (useSelfHosted && beat.wav_status !== "complete") {
        await supabase.from("beats").update({ wav_status: "complete" }).eq("id", beat.id);
        results.push("WAV: self-hosted audio is direct — marked complete");
      } else if (!useSelfHosted && beat.wav_status !== "complete" && beat.wav_status !== "processing") {
        // For sunoapi.org beats using LALAL.ai stems, still trigger WAV via sunoapi.org
        if (suno_api_key && callbackSecret) {
          try {
            const wavRes = await fetch("https://api.sunoapi.org/api/v1/wav/generate", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${suno_api_key}` },
              body: JSON.stringify({
                taskId: beat.task_id, audioId: beat.suno_id,
                callBackUrl: `${supabaseUrl}/functions/v1/wav-callback?secret=${callbackSecret}&beat_id=${beat.id}`,
              }),
            });
            if (wavRes.ok) {
              await supabase.from("beats").update({ wav_status: "processing" }).eq("id", beat.id);
              results.push("WAV conversion triggered via sunoapi.org");
            } else {
              results.push("WAV conversion skipped (sunoapi.org error)");
            }
          } catch { results.push("WAV conversion skipped (network error)"); }
        } else {
          results.push("WAV: skipped (no suno_api_key for sunoapi.org WAV)");
        }
      } else {
        results.push("WAV already complete");
      }

      // ─── STEMS: Use LALAL.ai for professional stem splitting ────────
      if (beat.stems_status !== "complete") {
        if (!lalalKey) {
          return new Response(
            JSON.stringify({
              error: "LALAL.ai API key required for stem splitting. Set yours via POST /functions/v1/update-agent-settings with { lalal_api_key: \"your-key\" }. Get one at lalal.ai/pricing",
              beat_id: beat.id,
            }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        } else {
        // ─── LALAL.AI STEM SPLITTING (two-phase to fit edge function limits) ─
        // Phase 1: upload + start split → store task IDs → return immediately
        // Phase 2: poll → download stems → store in Supabase
        const existingLalal = beat.stems && typeof beat.stems === "object" && (beat.stems as Record<string, unknown>)._lalal
          ? (beat.stems as Record<string, unknown>)._lalal as { source_id: string; task_ids: string[]; started_at: string }
          : null;

        if (!existingLalal) {
          // ─── PHASE 1: Upload to LALAL.ai + start split ────────────
          try {
            console.log(`LALAL.ai Phase 1 for beat ${beat.id} (suno_id: ${beat.suno_id})`);
            await supabase.from("beats").update({ stems_status: "processing" }).eq("id", beat.id);

            // Download MP3 from Suno CDN
            const audioUrl = `https://cdn1.suno.ai/${beat.suno_id}.mp3`;
            const audioRes = await fetch(audioUrl);
            if (!audioRes.ok) throw new Error(`Failed to download audio: HTTP ${audioRes.status}`);
            const audioData = new Uint8Array(await audioRes.arrayBuffer());
            console.log(`Downloaded ${audioData.length} bytes from ${audioUrl}`);

            // Upload to LALAL.ai
            const uploadRes = await fetch("https://www.lalal.ai/api/v1/upload/", {
              method: "POST",
              headers: {
                "X-License-Key": lalalKey,
                "Content-Disposition": `attachment; filename="${beat.suno_id}.mp3"`,
                "Content-Type": "audio/mpeg",
              },
              body: audioData,
            });
            if (!uploadRes.ok) {
              const errText = await uploadRes.text();
              throw new Error(`LALAL.ai upload failed: ${uploadRes.status} ${errText.slice(0, 200)}`);
            }
            const uploadData = await uploadRes.json();
            const sourceId = uploadData.source_id || uploadData.id;
            console.log(`LALAL.ai upload OK: source_id=${sourceId}, duration=${uploadData.duration}s`);

            // Start multistem split (2 batches, max 6 stems each)
            const STEM_BATCH_1 = ["vocals", "drum", "bass", "electric_guitar", "acoustic_guitar", "piano"];
            const STEM_BATCH_2 = ["synthesizer", "strings", "wind"];
            const taskIds: string[] = [];

            for (const stemList of [STEM_BATCH_1, STEM_BATCH_2]) {
              const splitRes = await fetch("https://www.lalal.ai/api/v1/split/multistem/", {
                method: "POST",
                headers: { "X-License-Key": lalalKey, "Content-Type": "application/json" },
                body: JSON.stringify({
                  source_id: sourceId,
                  presets: { stem_list: stemList, splitter: "phoenix", encoder_format: "mp3" },
                }),
              });
              if (!splitRes.ok) {
                const errText = await splitRes.text();
                console.error(`LALAL.ai split failed for batch: ${splitRes.status} ${errText.slice(0, 200)}`);
                continue;
              }
              const splitData = await splitRes.json();
              const tid = splitData.task_id || splitData.id;
              if (tid) taskIds.push(tid);
              console.log(`LALAL.ai split started: task_id=${tid}, stems=${stemList.join(",")}`);
            }

            if (taskIds.length === 0) throw new Error("LALAL.ai: no split tasks were created");

            // Store LALAL.ai state on the beat for Phase 2
            await supabase.from("beats").update({
              stems: { _lalal: { source_id: sourceId, task_ids: taskIds, started_at: new Date().toISOString() } },
              stems_status: "processing",
            }).eq("id", beat.id);

            results.push(`LALAL.ai split started (${taskIds.length} tasks). Call process-stems again in ~60s to complete.`);
            console.log(`Phase 1 done for beat ${beat.id}: source_id=${sourceId}, tasks=${taskIds.join(",")}`);
          } catch (lalalErr) {
            console.error(`LALAL.ai Phase 1 failed for beat ${beat.id}:`, (lalalErr as Error).message);
            await supabase.from("beats").update({ stems_status: "failed", stems: null }).eq("id", beat.id);
            results.push(`Stem splitting failed: ${(lalalErr as Error).message}`);
          }
        } else {
          // ─── PHASE 2: Poll + download + store ──────────────────────
          try {
            const { source_id: sourceId, task_ids: taskIds, started_at } = existingLalal;
            const elapsedMs = Date.now() - new Date(started_at).getTime();
            console.log(`LALAL.ai Phase 2 for beat ${beat.id}: ${taskIds.length} tasks, ${Math.round(elapsedMs / 1000)}s elapsed`);

            // Poll LALAL.ai (up to 8 polls × 5s = 40s max in this invocation)
            const POLL_INTERVAL = 5_000;
            const MAX_POLLS = 8;
            let allComplete = false;
            let completedStems: Record<string, string> = {};

            for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
              if (attempt > 0) await new Promise(r => setTimeout(r, POLL_INTERVAL));

              const checkRes = await fetch("https://www.lalal.ai/api/v1/check/", {
                method: "POST",
                headers: { "X-License-Key": lalalKey, "Content-Type": "application/json" },
                body: JSON.stringify({ task_ids: taskIds }),
              });
              if (!checkRes.ok) { console.warn(`LALAL.ai check HTTP ${checkRes.status}`); continue; }

              const checkData = await checkRes.json();
              let doneCount = 0;
              let errorCount = 0;

              for (const taskId of taskIds) {
                // LALAL.ai nests results under checkData.result[taskId]
                const taskResult = checkData.result?.[taskId] || checkData[taskId] || checkData.results?.[taskId];
                if (!taskResult) { console.log(`No result for task ${taskId}, keys: ${Object.keys(checkData).join(",")}`); continue; }
                const status = taskResult.status || taskResult.state;
                console.log(`Task ${taskId} status: ${status}`);
                if (status === "success" || status === "done" || status === "complete") {
                  doneCount++;
                  // Tracks are at taskResult.result.tracks (nested .result)
                  const tracks = taskResult.result?.tracks || taskResult.tracks || [];
                  for (const track of tracks) {
                    const label = (track.label || track.type || track.name || "unknown").toLowerCase().replace(/\s+/g, "_");
                    if (track.url && track.type !== "back" && label !== "no_multistem") completedStems[label] = track.url;
                  }
                } else if (status === "error" || status === "failed") {
                  errorCount++;
                  console.error(`LALAL.ai task ${taskId} failed: ${JSON.stringify(taskResult)}`);
                }
              }

              console.log(`LALAL.ai poll ${attempt + 1}/${MAX_POLLS}: ${doneCount}/${taskIds.length} done, ${errorCount} errors, ${Object.keys(completedStems).length} stems`);
              if (doneCount + errorCount >= taskIds.length) { allComplete = true; break; }
            }

            if (!allComplete) {
              // Still processing — check if we've been waiting too long (>5 min = give up)
              if (elapsedMs > 300_000) {
                await supabase.from("beats").update({ stems_status: "failed", stems: null }).eq("id", beat.id);
                results.push("Stem splitting timed out after 5 minutes. Please try again.");
              } else {
                results.push(`LALAL.ai still processing. Call again in ~30s (elapsed: ${Math.round(elapsedMs / 1000)}s).`);
              }
            } else if (Object.keys(completedStems).length > 0) {
              // ─── DOWNLOAD & STORE STEMS ──────────────────────────────
              const storedStems: Record<string, string> = {};
              let samplesCreated = 0;
              let samplesSkipped = 0;

              for (const [stemType, stemUrl] of Object.entries(completedStems)) {
                try {
                  const stemRes = await fetch(stemUrl);
                  if (!stemRes.ok) { console.warn(`Failed to download ${stemType}: ${stemRes.status}`); continue; }
                  const stemData = new Uint8Array(await stemRes.arrayBuffer());
                  const fileSize = stemData.length;
                  if (fileSize < 1000) { samplesSkipped++; continue; }

                  // Upload to Supabase storage
                  const storagePath = `beats/${beat.id}/stems/${stemType}.mp3`;
                  const { error: uploadErr } = await supabase.storage.from("audio").upload(
                    storagePath, stemData, { contentType: "audio/mpeg", upsert: true }
                  );
                  if (uploadErr) console.error(`Storage upload error ${stemType}: ${uploadErr.message}`);

                  const { data: publicUrlData } = supabase.storage.from("audio").getPublicUrl(storagePath);
                  const publicUrl = publicUrlData?.publicUrl || stemUrl;
                  storedStems[stemType] = publicUrl;

                  // Silence detection: Shannon entropy on 32KB from middle
                  let isSilent = false;
                  try {
                    const midpoint = Math.floor(fileSize / 2);
                    const rangeStart = Math.max(0, midpoint - 16384);
                    const rangeEnd = Math.min(fileSize - 1, midpoint + 16383);
                    const buf = stemData.slice(rangeStart, rangeEnd);
                    const freq = new Array(256).fill(0);
                    for (let i = 0; i < buf.length; i++) freq[buf[i]]++;
                    let entropy = 0;
                    for (let i = 0; i < 256; i++) {
                      if (freq[i] === 0) continue;
                      const p = freq[i] / buf.length;
                      entropy -= p * Math.log2(p);
                    }
                    isSilent = entropy < 7.5;
                    console.log(`Stem ${stemType}: ${fileSize}B, entropy=${entropy.toFixed(3)}, silent=${isSilent}`);
                  } catch { /* ignore entropy errors */ }

                  if (isSilent || EXCLUDED_SAMPLE_TYPES.has(stemType)) { samplesSkipped++; continue; }

                  const { error: sampleErr } = await supabase.from("samples").upsert(
                    { beat_id: beat.id, stem_type: stemType, audio_url: publicUrl, file_size: fileSize, audio_amplitude: fileSize, storage_migrated: true },
                    { onConflict: "beat_id,stem_type" }
                  );
                  if (sampleErr) console.error(`Sample insert error ${stemType}: ${sampleErr.message}`);
                  else samplesCreated++;
                } catch (stemErr) {
                  console.warn(`Stem processing error for ${stemType}: ${(stemErr as Error).message}`);
                }
              }

              // Update beat — replace _lalal state with final stem URLs
              await supabase.from("beats").update({ stems: storedStems, stems_status: "complete" }).eq("id", beat.id);
              results.push(`Stems complete via LALAL.ai: ${Object.keys(storedStems).join(", ")} (${Object.keys(storedStems).length} stems)`);
              results.push(`Samples: ${samplesCreated} created, ${samplesSkipped} skipped (silent/excluded)`);
              console.log(`Beat ${beat.id} LALAL.ai stems complete: ${Object.keys(storedStems).join(", ")}`);

              // Clean up LALAL.ai source file
              try {
                await fetch("https://www.lalal.ai/api/v1/delete/", {
                  method: "POST",
                  headers: { "X-License-Key": lalalKey, "Content-Type": "application/json" },
                  body: JSON.stringify({ source_id: sourceId }),
                });
              } catch { /* best-effort cleanup */ }
            } else {
              await supabase.from("beats").update({ stems_status: "failed", stems: null }).eq("id", beat.id);
              results.push("Stem splitting failed: LALAL.ai returned no stems");
            }
          } catch (lalalErr) {
            console.error(`LALAL.ai Phase 2 failed for beat ${beat.id}:`, (lalalErr as Error).message);
            await supabase.from("beats").update({ stems_status: "failed", stems: null }).eq("id", beat.id);
            results.push(`Stem splitting failed: ${(lalalErr as Error).message}`);
          }
        }
        } // close else (lalal key present)
      } else {
        results.push("Stems already complete");
      }

    } else {
      // ─── SUNOAPI.ORG: WAV + STEMS (existing logic) ────────────────

      // 1. WAV conversion — auto-triggered by suno-callback, manual retry here as fallback
      if (beat.wav_status === "failed" || (beat.wav_status !== "complete" && beat.wav_status !== "processing")) {
        try {
          const wavRes = await fetch("https://api.sunoapi.org/api/v1/wav/generate", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${suno_api_key}`,
            },
            body: JSON.stringify({
              taskId: beat.task_id,
              audioId: beat.suno_id,
              callBackUrl: `${supabaseUrl}/functions/v1/wav-callback?secret=${callbackSecret}&beat_id=${beat.id}`,
            }),
          });

          const wavBody = await wavRes.text();
          console.log(`WAV retry for beat ${beat.id}: status=${wavRes.status} body=${wavBody.slice(0, 500)}`);

          let wavApiError = false;
          try {
            const wavJson = JSON.parse(wavBody);
            if (wavJson.code && wavJson.code >= 400) wavApiError = true;
            if (wavJson.error || wavJson.message?.toLowerCase().includes("error")) wavApiError = true;
          } catch { /* not JSON */ }

          if (wavRes.ok && !wavApiError) {
            await supabase.from("beats").update({ wav_status: "processing" }).eq("id", beat.id);
            results.push("WAV conversion re-triggered (was failed/missing)");
          } else {
            await supabase.from("beats").update({ wav_status: "failed" }).eq("id", beat.id);
            results.push("WAV conversion retry failed: " + (wavRes.status === 401 ? "Invalid API key" : `API error (${wavRes.status})`));
          }
        } catch (wavErr) {
          console.error(`WAV retry failed for beat ${beat.id}:`, wavErr.message);
          await supabase.from("beats").update({ wav_status: "failed" }).eq("id", beat.id);
          results.push("WAV conversion retry failed: network error");
        }
      } else if (beat.wav_status === "processing") {
        results.push("WAV conversion in progress (auto-triggered)");
      } else {
        results.push("WAV already complete");
      }

      // 2. Trigger stem splitting (if not already complete)
      if (beat.stems_status !== "complete") {
        try {
          const stemsRes = await fetch("https://api.sunoapi.org/api/v1/vocal-removal/generate", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${suno_api_key}`,
            },
            body: JSON.stringify({
              taskId: beat.task_id,
              audioId: beat.suno_id,
              type: "split_stem",
              callBackUrl: `${supabaseUrl}/functions/v1/stems-callback?secret=${callbackSecret}&beat_id=${beat.id}`,
            }),
          });

          const stemsBody = await stemsRes.text();
          console.log(`Stems API response for beat ${beat.id}: status=${stemsRes.status} body=${stemsBody.slice(0, 500)}`);

          let stemsApiError = false;
          try {
            const stemsJson = JSON.parse(stemsBody);
            if (stemsJson.code && stemsJson.code >= 400) stemsApiError = true;
            if (stemsJson.error || stemsJson.message?.toLowerCase().includes("error")) stemsApiError = true;
          } catch { /* not JSON, check status only */ }

          if (stemsRes.ok && !stemsApiError) {
            await supabase.from("beats").update({ stems_status: "processing" }).eq("id", beat.id);
            results.push("Stem splitting triggered (50 credits)");
            console.log(`Stems triggered for beat ${beat.id} by agent ${agent.handle}`);
          } else {
            console.error(`Stems API error for beat ${beat.id}: status=${stemsRes.status} body=${stemsBody.slice(0, 500)}`);
            await supabase.from("beats").update({ stems_status: "failed" }).eq("id", beat.id);
            results.push("Stem splitting failed: " + (stemsRes.status === 401 ? "Invalid API key" : `API error (${stemsRes.status})`));
          }
        } catch (stemsErr) {
          console.error(`Stems trigger failed for beat ${beat.id}:`, stemsErr.message);
          await supabase.from("beats").update({ stems_status: "failed" }).eq("id", beat.id);
          results.push("Stem splitting failed: network error");
        }
      } else {
        results.push("Stems already complete");
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        beat_id: beat.id,
        beat_title: beat.title,
        generation_source: generationSource,
        ...(gcreditDeducted ? { gcredit_spent: 1 } : {}),
        results,
        message: useLalal
          ? "Stem splitting via LALAL.ai (agent's API key). Up to 9 stems extracted."
          : "Stem splitting via sunoapi.org (split_stem). Callback updates the beat. Your key was used and NOT stored.",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Process stems error:", err.message);
    return new Response(
      JSON.stringify({ error: "Failed to process stems. Please try again." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
