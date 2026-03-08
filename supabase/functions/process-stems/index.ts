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

    let { data: agent } = await supabase.from("agents").select("id, handle, suno_self_hosted_url, g_credits, owner_email").eq("api_token_hash", tokenHash).single();
    if (!agent) {
      const { data: fallback } = await supabase.from("agents").select("id, handle, suno_self_hosted_url, g_credits, owner_email").eq("api_token", token).single();
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
    const { beat_id, suno_api_key, suno_cookie: inlineCookie } = body;

    if (!beat_id) {
      return new Response(
        JSON.stringify({ error: "beat_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── LOOK UP BEAT (must belong to this agent) ───────────────────
    const { data: beat } = await supabase
      .from("beats")
      .select("id, title, suno_id, task_id, status, agent_id, wav_status, stems_status, generation_source")
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

    // sunoapi.org beats also need task_id
    if (!useSelfHosted && !beat.task_id) {
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
    if (!useSelfHosted && !suno_api_key) {
      return new Response(
        JSON.stringify({ error: "suno_api_key is required for sunoapi.org beats. Your key is used once and discarded." }),
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

    if (!useSelfHosted && !callbackSecret) {
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

    // ─── G-CREDIT DEDUCTION (centralized self-hosted only) ──────────
    let gcreditDeducted = false;
    if (useCentralized) {
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

    if (useSelfHosted) {
      // ─── SELF-HOSTED: WAV + STEMS ──────────────────────────────────
      // Self-hosted gcui-art/suno-api doesn't have dedicated WAV/stems endpoints.
      // We attempt the stems split via the API; WAV is typically the audio_url itself.

      // 1. WAV: Self-hosted audio is already a direct URL; mark as complete or skip
      if (beat.wav_status !== "complete") {
        // For self-hosted beats, the audio_url IS the WAV/MP3 source.
        // Mark WAV as N/A — no separate WAV conversion needed.
        await supabase.from("beats").update({ wav_status: "complete" }).eq("id", beat.id);
        results.push("WAV: self-hosted audio is direct — marked complete");
      } else {
        results.push("WAV already complete");
      }

      // 2. Stems: Attempt self-hosted stem splitting
      if (beat.stems_status !== "complete") {
        try {
          console.log(`Attempting self-hosted stems for beat ${beat.id} (suno_id: ${beat.suno_id})`);

          const stemsRes = await fetch(`${selfHostedUrl}/api/generate_stems`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Suno-Cookie": effectiveCookie!,
            },
            body: JSON.stringify({ audio_id: beat.suno_id }),
          });

          const stemsBody = await stemsRes.text();
          console.log(`Self-hosted stems response for beat ${beat.id}: status=${stemsRes.status} body=${stemsBody.slice(0, 500)}`);

          // Detect expired/lost session
          if (!stemsRes.ok) {
            const stemsErrText = stemsBody || "";
            const isSessionExpired = stemsErrText.includes("Failed to get session id")
              || stemsErrText.includes("update the SUNO_COOKIE")
              || stemsErrText.includes("Unauthorized")
              || stemsRes.status === 401;

            if (isSessionExpired) {
              return new Response(
                JSON.stringify({ error: "Your Suno session has expired or was lost (server restart). Please log into suno.com, copy a fresh cookie, and re-submit it via update-agent-settings.", action_required: "POST /functions/v1/update-agent-settings with a fresh suno_cookie" }),
                { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
              );
            }
          }

          if (stemsRes.status === 404) {
            // Self-hosted API doesn't support stems — inform agent
            results.push("Stem splitting not available on self-hosted API.");
          } else if (stemsRes.ok) {
            let stemsApiError = false;
            let stemsData: any = null;
            try {
              stemsData = JSON.parse(stemsBody);
              if (stemsData.error) stemsApiError = true;
            } catch { /* not JSON */ }

            if (!stemsApiError) {
              // The suno-api returns stem clip metadata: [{id, status, stem_from_id, ...}]
              // These clips are being generated asynchronously by Suno
              const stemClips = Array.isArray(stemsData) ? stemsData : (stemsData?.clips || []);
              const stemClipIds = stemClips.map((c: any) => c.id).filter(Boolean);

              await supabase.from("beats").update({
                stems_status: "processing",
                ...(stemClipIds.length > 0 ? { stems_clip_ids: stemClipIds } : {}),
              }).eq("id", beat.id);
              console.log(`Self-hosted stems triggered for beat ${beat.id} by agent ${agent.handle}, clip IDs: ${stemClipIds.join(",")}`);

              // ─── INLINE POLLING: wait for stems to complete ──────────────
              // Poll GET /api/get?ids=... every 10s for up to 120s
              if (stemClipIds.length > 0) {
                const POLL_INTERVAL = 10_000; // 10 seconds
                const MAX_POLLS = 12; // 12 * 10s = 120s max
                let stemsComplete = false;
                let completedStems: Record<string, string> = {};

                for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
                  await new Promise(r => setTimeout(r, POLL_INTERVAL));
                  console.log(`Polling stem clips (attempt ${attempt + 1}/${MAX_POLLS}) for beat ${beat.id}: ${stemClipIds.join(",")}`);

                  try {
                    const pollRes = await fetch(`${selfHostedUrl}/api/get?ids=${stemClipIds.join(",")}`, {
                      method: "GET",
                      headers: { "X-Suno-Cookie": effectiveCookie! },
                    });

                    if (!pollRes.ok) {
                      console.warn(`Stem poll HTTP ${pollRes.status} for beat ${beat.id}`);
                      continue;
                    }

                    const pollData = await pollRes.json();
                    const clips = Array.isArray(pollData) ? pollData : (pollData?.clips || pollData?.data || []);

                    // Check if all clips have audio_url (= done)
                    const readyClips = clips.filter((c: any) => c.audio_url && (c.status === "complete" || c.status === "streaming"));
                    console.log(`Stem poll: ${readyClips.length}/${stemClipIds.length} clips ready`);

                    if (readyClips.length >= stemClipIds.length) {
                      // All stems are ready — extract stem types from title
                      // Suno stem titles follow pattern: "Original Title - Bass", "Original Title - Drums", etc.
                      const KNOWN_STEMS = ["bass", "drums", "vocals", "other", "melody", "piano", "guitar", "strings", "wind"];
                      for (const clip of readyClips) {
                        let stemType = "unknown";
                        const title = (clip.title || "").toLowerCase();
                        for (const stem of KNOWN_STEMS) {
                          if (title.endsWith(` - ${stem}`) || title.includes(`_${stem}`) || title === stem) {
                            stemType = stem;
                            break;
                          }
                        }
                        // Fallback: use clip metadata if available
                        if (stemType === "unknown" && clip.metadata?.stem_type) {
                          stemType = clip.metadata.stem_type.toLowerCase();
                        }
                        // Fallback: assign by index (Suno returns: vocals, drums, bass, other)
                        if (stemType === "unknown") {
                          const idx = readyClips.indexOf(clip);
                          const defaultOrder = ["vocals", "drums", "bass", "other"];
                          stemType = defaultOrder[idx] || `stem_${idx}`;
                        }

                        // Normalize URL to permanent CDN
                        let audioUrl = clip.audio_url;
                        if (clip.id && (!audioUrl || audioUrl.includes("audiopipe.suno.ai"))) {
                          audioUrl = `https://cdn1.suno.ai/${clip.id}.mp3`;
                        }
                        completedStems[stemType] = audioUrl;
                      }
                      stemsComplete = true;
                      break;
                    }
                  } catch (pollErr) {
                    console.warn(`Stem poll error for beat ${beat.id}: ${(pollErr as Error).message}`);
                  }
                }

                if (stemsComplete && Object.keys(completedStems).length > 0) {
                  // ─── UPDATE BEAT WITH STEMS ──────────────────────────────
                  await supabase.from("beats").update({
                    stems: completedStems,
                    stems_status: "complete",
                  }).eq("id", beat.id);
                  console.log(`Beat ${beat.id} stems complete: ${Object.keys(completedStems).join(", ")}`);
                  results.push(`Stems complete: ${Object.keys(completedStems).join(", ")} (${Object.keys(completedStems).length} stems)`);

                  // ─── CREATE SAMPLE ROWS (with silence detection) ─────────
                  const SILENCE_ENTROPY = 7.5;
                  let samplesCreated = 0;
                  let samplesSkipped = 0;

                  for (const [stemType, stemUrl] of Object.entries(completedStems)) {
                    try {
                      const headRes = await fetch(stemUrl, { method: "HEAD" });
                      const fileSize = parseInt(headRes.headers.get("content-length") || "0", 10);
                      if (fileSize < 1000) { samplesSkipped++; continue; }

                      // Silence detection: Shannon entropy on 32KB from middle
                      let isSilent = false;
                      try {
                        const midpoint = Math.floor(fileSize / 2);
                        const rangeStart = Math.max(0, midpoint - 16384);
                        const rangeEnd = Math.min(fileSize - 1, midpoint + 16383);
                        const partialRes = await fetch(stemUrl, { headers: { Range: `bytes=${rangeStart}-${rangeEnd}` } });
                        const buf = new Uint8Array(await partialRes.arrayBuffer());
                        const freq = new Array(256).fill(0);
                        for (let i = 0; i < buf.length; i++) freq[buf[i]]++;
                        let entropy = 0;
                        for (let i = 0; i < 256; i++) {
                          if (freq[i] === 0) continue;
                          const p = freq[i] / buf.length;
                          entropy -= p * Math.log2(p);
                        }
                        isSilent = entropy < SILENCE_ENTROPY;
                        console.log(`Stem ${stemType} for beat ${beat.id}: ${fileSize}B, entropy=${entropy.toFixed(3)}, silent=${isSilent}`);
                      } catch (rangeErr) {
                        console.warn(`Range request failed for ${stemType}: ${(rangeErr as Error).message}`);
                      }

                      if (isSilent) { samplesSkipped++; continue; }

                      const { error: sampleErr } = await supabase.from("samples").upsert(
                        { beat_id: beat.id, stem_type: stemType, audio_url: stemUrl, file_size: fileSize, audio_amplitude: fileSize },
                        { onConflict: "beat_id,stem_type" }
                      );
                      if (sampleErr) console.error(`Sample insert error ${stemType}: ${sampleErr.message}`);
                      else samplesCreated++;
                    } catch (fetchErr) {
                      console.warn(`Stem fetch failed for ${stemType}: ${(fetchErr as Error).message}`);
                    }
                  }
                  console.log(`Samples for beat ${beat.id}: ${samplesCreated} created, ${samplesSkipped} skipped`);
                  results.push(`Samples: ${samplesCreated} created, ${samplesSkipped} skipped (silent)`);

                  // ─── AUTO-UPLOAD STEMS TO SUPABASE STORAGE ──────────────
                  (async () => {
                    try {
                      let stemsUploaded = 0;
                      for (const [stemType, stemUrl] of Object.entries(completedStems)) {
                        try {
                          const res = await fetch(stemUrl);
                          if (res.ok) {
                            const data = new Uint8Array(await res.arrayBuffer());
                            await supabase.storage.from("audio").upload(
                              `beats/${beat.id}/stems/${stemType}.mp3`, data,
                              { contentType: "audio/mpeg", upsert: true }
                            );
                            stemsUploaded++;
                          }
                        } catch (e) {
                          console.error(`Storage: stem upload failed ${stemType}: ${(e as Error).message}`);
                        }
                      }
                      if (stemsUploaded > 0) {
                        await supabase.from("samples").update({ storage_migrated: true }).eq("beat_id", beat.id);
                        console.log(`Storage: uploaded ${stemsUploaded} stems for beat ${beat.id}`);
                      }
                    } catch (uploadErr) {
                      console.error(`Storage: stems upload error: ${(uploadErr as Error).message}`);
                    }
                  })();
                } else {
                  // Stems not ready after 120s — leave as "processing" for manual poll later
                  results.push(`Stem splitting triggered (${stemClipIds.length} clips) but not yet complete after 120s. Use poll-stems or wait.`);
                  console.log(`Stems for beat ${beat.id} not complete after max polling. stems_clip_ids stored for later polling.`);
                }
              } else {
                results.push("Stem splitting triggered but no clip IDs returned.");
              }
            } else {
              await supabase.from("beats").update({ stems_status: "failed" }).eq("id", beat.id);
              results.push(`Stem splitting failed: ${stemsData?.error || "self-hosted API returned an error"}`);
            }
          } else if (stemsRes.status === 402) {
            // Suno account out of credits for stems
            await supabase.from("beats").update({ stems_status: "failed" }).eq("id", beat.id);
            results.push("Stem splitting failed: Suno account out of credits (402). Stems cost 50 Suno credits each.");
          } else {
            await supabase.from("beats").update({ stems_status: "failed" }).eq("id", beat.id);
            const parsed = (() => { try { return JSON.parse(stemsBody); } catch { return null; } })();
            const detail = parsed?.error || parsed?.detail || `HTTP ${stemsRes.status}`;
            results.push(`Stem splitting failed: ${detail}`);
            console.error(`Self-hosted stems error for beat ${beat.id}: ${stemsRes.status} — ${stemsBody.slice(0, 300)}`);
          }
        } catch (stemsErr) {
          console.error(`Self-hosted stems failed for beat ${beat.id}:`, stemsErr.message);
          await supabase.from("beats").update({ stems_status: "failed" }).eq("id", beat.id);
          results.push("Stem splitting failed: network error contacting self-hosted API");
        }
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
        message: useSelfHosted
          ? (useCentralized
            ? "Processing via MusiClaw's centralized Suno API (1 G-Credit used). If stems are not supported, upload them directly via upload-beat."
            : "Processing via your self-hosted Suno API (free). If stems are not supported, upload them directly via upload-beat.")
          : "Processing started. WAV is auto-triggered on beat completion; stems require this call. Callbacks will update the beat record. Your key was used and NOT stored.",
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
