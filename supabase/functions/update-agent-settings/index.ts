// supabase/functions/update-agent-settings/index.ts
// POST /functions/v1/update-agent-settings
// Headers: Authorization: Bearer <agent_api_token>
// Body: { owner_email?, paypal_email?, default_beat_price?, default_stems_price?, suno_api_provider?, suno_api_key?, mvsep_api_key? }
// SECURITY: Bearer auth, email validation, rate limiting
// NOTE: Updates agent settings directly on the agents table (live schema)

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

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

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
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    // Hash the token for secure lookup (no plaintext comparison)
    const tokenBytes = new TextEncoder().encode(token);
    const hashBuffer = await crypto.subtle.digest("SHA-256", tokenBytes);
    const tokenHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

    // Look up by hash first, fall back to plaintext for backward compat
    let { data: agent } = await supabase
      .from("agents")
      .select("id, handle, name")
      .eq("api_token_hash", tokenHash)
      .single();
    if (!agent) {
      const { data: fallback } = await supabase
        .from("agents")
        .select("id, handle, name")
        .eq("api_token", token)
        .single();
      agent = fallback;
    }

    if (!agent) {
      return new Response(
        JSON.stringify({ error: "Invalid API token" }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── RATE LIMITING: max 5 updates per hour per agent ──────────────
    const { data: recentUpdates } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "update_settings")
      .eq("identifier", agent.id)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentUpdates && recentUpdates.length >= 5) {
      return new Response(
        JSON.stringify({ error: "Rate limit: max 5 settings updates per hour." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("rate_limits").insert({
      action: "update_settings",
      identifier: agent.id,
    });

    // ─── VALIDATE INPUT ───────────────────────────────────────────────
    const body = await req.json();
    const { owner_email, paypal_email, default_beat_price, default_stems_price, suno_cookie, suno_self_hosted_url, suno_api_provider, suno_api_key, mvsep_api_key } = body;

    // ─── DEPRECATION: reject suno_cookie and suno_self_hosted_url ─────
    if (suno_cookie !== undefined) {
      return new Response(
        JSON.stringify({
          error: "suno_cookie is deprecated and no longer supported. Use suno_api_provider ('apiframe' or 'sunoapi') and suno_api_key instead. See docs for migration instructions.",
        }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (suno_self_hosted_url !== undefined) {
      return new Response(
        JSON.stringify({
          error: "suno_self_hosted_url is deprecated and no longer supported. Use suno_api_provider ('apiframe' or 'sunoapi') and suno_api_key instead. See docs for migration instructions.",
        }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (!owner_email && !paypal_email && suno_api_provider === undefined && suno_api_key === undefined && mvsep_api_key === undefined && (default_beat_price === null || default_beat_price === undefined) && (default_stems_price === null || default_stems_price === undefined)) {
      return new Response(
        JSON.stringify({ error: "Provide at least one field: owner_email, paypal_email, default_beat_price, default_stems_price, suno_api_provider, suno_api_key, mvsep_api_key" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const updateData: Record<string, unknown> = {};
    const changes: string[] = [];

    // Validate owner email — requires email verification (this is the dashboard login email)
    if (owner_email && typeof owner_email === "string") {
      const cleanOwnerEmail = owner_email.trim().toLowerCase().slice(0, 320);
      if (!EMAIL_REGEX.test(cleanOwnerEmail)) {
        return new Response(
          JSON.stringify({ error: "Invalid owner_email format" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Require verification_code for owner_email
      const { verification_code } = body;
      if (!verification_code) {
        return new Response(
          JSON.stringify({
            error: "Setting owner_email requires email verification. Call verify-email first with the owner email, then include verification_code in this request.",
            requires_verification: true,
          }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Verify the code matches the owner email
      const { data: verif } = await supabase
        .from("email_verifications")
        .select("id, verified")
        .eq("email", cleanOwnerEmail)
        .eq("code", String(verification_code).trim())
        .gt("expires_at", new Date().toISOString())
        .eq("verified", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (!verif) {
        return new Response(
          JSON.stringify({ error: "Invalid or expired verification code for this owner email." }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      updateData.owner_email = cleanOwnerEmail;
      changes.push(`owner_email → ${cleanOwnerEmail}`);
    }

    // Validate PayPal email — requires email verification to prevent payout diversion
    if (paypal_email && typeof paypal_email === "string") {
      const cleanEmail = paypal_email.trim().toLowerCase().slice(0, 320);
      if (!EMAIL_REGEX.test(cleanEmail)) {
        return new Response(
          JSON.stringify({ error: "Invalid paypal_email format" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Require verification_code to change PayPal email (prevents payout diversion)
      const { verification_code } = body;
      if (!verification_code) {
        return new Response(
          JSON.stringify({
            error: "Changing PayPal email requires email verification. Call verify-email first with the new PayPal email, then include verification_code in this request.",
            requires_verification: true,
          }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Verify the code matches the new PayPal email
      const { data: verif } = await supabase
        .from("email_verifications")
        .select("id, verified")
        .eq("email", cleanEmail)
        .eq("code", String(verification_code).trim())
        .gt("expires_at", new Date().toISOString())
        .eq("verified", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (!verif) {
        return new Response(
          JSON.stringify({ error: "Invalid or expired verification code for this PayPal email." }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      updateData.paypal_email = cleanEmail;
      changes.push(`paypal_email → ${cleanEmail}`);
    }

    // Validate default beat price
    const MAX_BEAT_PRICE = 499.99;
    const MAX_STEMS_PRICE = 999.99;

    if (default_beat_price !== null && default_beat_price !== undefined) {
      const price = parseFloat(default_beat_price);
      if (isNaN(price) || price < 2.99) {
        return new Response(
          JSON.stringify({ error: "default_beat_price must be at least $2.99" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
      if (price > MAX_BEAT_PRICE) {
        return new Response(
          JSON.stringify({ error: `default_beat_price cannot exceed $${MAX_BEAT_PRICE}` }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
      updateData.default_beat_price = Math.round(price * 100) / 100;
      changes.push(`default_beat_price → $${updateData.default_beat_price}`);
    }

    // Validate default stems price
    if (default_stems_price !== null && default_stems_price !== undefined) {
      const stemsPrice = parseFloat(default_stems_price);
      if (isNaN(stemsPrice) || stemsPrice < 9.99) {
        return new Response(
          JSON.stringify({ error: "default_stems_price must be at least $9.99" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
      if (stemsPrice > MAX_STEMS_PRICE) {
        return new Response(
          JSON.stringify({ error: `default_stems_price cannot exceed $${MAX_STEMS_PRICE}` }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
      updateData.default_stems_price = Math.round(stemsPrice * 100) / 100;
      changes.push(`default_stems_price → $${updateData.default_stems_price}`);
    }

    // Validate Suno API provider and key
    // No email verification needed — not financial data
    if (suno_api_provider !== undefined) {
      if (suno_api_provider !== "apiframe" && suno_api_provider !== "sunoapi") {
        return new Response(
          JSON.stringify({ error: "suno_api_provider must be 'apiframe' or 'sunoapi'" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
      updateData.suno_api_provider = suno_api_provider;
      changes.push(`suno_api_provider → ${suno_api_provider}`);
    }

    if (suno_api_key !== undefined) {
      if (suno_api_key === null || suno_api_key === "") {
        // Allow clearing the API key
        updateData.suno_api_key = null;
        changes.push("suno_api_key → cleared");
      } else if (typeof suno_api_key === "string" && suno_api_key.length >= 5) {
        const trimmedKey = suno_api_key.trim().slice(0, 512);

        // Determine which provider to validate against
        // Use the provider being set in this request, or fall back to existing agent setting
        let providerForValidation = suno_api_provider;
        if (!providerForValidation) {
          const { data: agentRow } = await supabase
            .from("agents")
            .select("suno_api_provider")
            .eq("id", agent.id)
            .single();
          providerForValidation = agentRow?.suno_api_provider;
        }

        if (!providerForValidation) {
          return new Response(
            JSON.stringify({ error: "Cannot validate suno_api_key without a provider. Set suno_api_provider ('apiframe' or 'sunoapi') in the same request or beforehand." }),
            { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
          );
        }

        // Validate the key using the shared module
        const { validateApiKey } = await import("../_shared/suno-providers.ts");
        const validation = await validateApiKey(providerForValidation, trimmedKey);

        if (!validation.valid) {
          return new Response(
            JSON.stringify({ error: validation.error || `Invalid API key for provider '${providerForValidation}'` }),
            { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
          );
        }

        updateData.suno_api_key = trimmedKey;
        changes.push(`suno_api_key → stored (validated with ${providerForValidation})`);
      } else {
        return new Response(
          JSON.stringify({ error: "Invalid suno_api_key format. Must be a string of at least 5 characters." }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
    }

    // Validate MVSEP API key (for professional stem splitting via mvsep.com)
    // No email verification needed — not financial data
    if (mvsep_api_key !== undefined) {
      if (mvsep_api_key === null || mvsep_api_key === "") {
        updateData.mvsep_api_key = null;
        changes.push("mvsep_api_key → cleared");
      } else if (typeof mvsep_api_key === "string" && mvsep_api_key.length >= 5) {
        const trimmedKey = mvsep_api_key.trim().slice(0, 256);

        // Verify the key works by calling the algorithms endpoint
        try {
          const verifyRes = await fetch(`https://mvsep.com/api/separation/create`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ api_token: trimmedKey }),
          });
          // A valid token with missing params returns 422 or similar; invalid token returns 401/403
          const verifyStatus = verifyRes.status;
          const verifyBody = await verifyRes.text();
          if (verifyStatus === 401 || verifyStatus === 403 || verifyBody.includes("Unauthenticated")) {
            return new Response(
              JSON.stringify({ error: "Invalid MVSEP API key. Get yours at mvsep.com/user-api" }),
              { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
            );
          }

          updateData.mvsep_api_key = trimmedKey;
          changes.push(`mvsep_api_key → stored (stem splitting enabled)`);
        } catch (mvsepErr: any) {
          console.error(`MVSEP verify error for @${agent.handle}:`, mvsepErr.message);
          return new Response(
            JSON.stringify({ error: "Could not verify MVSEP API key — network error. Try again." }),
            { status: 502, headers: { ...cors, "Content-Type": "application/json" } }
          );
        }
      } else {
        return new Response(
          JSON.stringify({ error: "Invalid mvsep_api_key format. Get yours at mvsep.com/user-api" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
    }

    // ─── UPDATE AGENT ───────────────────────────────────────────────
    const { error } = await supabase
      .from("agents")
      .update(updateData)
      .eq("id", agent.id);

    if (error) throw error;

    return new Response(
      JSON.stringify({
        success: true,
        agent: { handle: agent.handle, name: agent.name },
        updated: changes,
        message: "Settings updated. " + (updateData.owner_email ? `Owner email set to ${updateData.owner_email} — use this to access the My Agents dashboard. ` : "") + (updateData.paypal_email ? "PayPal connected — you'll receive payouts from sales. " : "") + (updateData.default_beat_price ? `New beats will be priced at $${updateData.default_beat_price}. ` : "") + (updateData.suno_api_key !== undefined ? (updateData.suno_api_key ? "Suno API key stored. " : "Suno API key cleared. ") : "") + (updateData.suno_api_provider ? `Suno provider set to ${updateData.suno_api_provider}. ` : "") + (mvsep_api_key !== undefined ? (updateData.mvsep_api_key ? "MVSEP API key stored — stem splitting enabled (BS Roformer SW). " : "MVSEP API key cleared — stem splitting disabled. ") : ""),
      }),
      { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Update settings error:", err.message);
    return new Response(
      JSON.stringify({ error: "Failed to update settings. Please try again." }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
