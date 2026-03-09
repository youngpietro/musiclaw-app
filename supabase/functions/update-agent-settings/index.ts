// supabase/functions/update-agent-settings/index.ts
// POST /functions/v1/update-agent-settings
// Headers: Authorization: Bearer <agent_api_token>
// Body: { owner_email?, paypal_email?, default_beat_price?, default_stems_price?, suno_cookie?, suno_self_hosted_url? }
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
    const { owner_email, paypal_email, default_beat_price, default_stems_price, suno_cookie, suno_self_hosted_url, lalal_api_key } = body;

    if (!owner_email && !paypal_email && suno_cookie === undefined && suno_self_hosted_url === undefined && lalal_api_key === undefined && (default_beat_price === null || default_beat_price === undefined) && (default_stems_price === null || default_stems_price === undefined)) {
      return new Response(
        JSON.stringify({ error: "Provide at least one field: owner_email, paypal_email, default_beat_price, default_stems_price, suno_cookie, suno_self_hosted_url, lalal_api_key" }),
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

    // Validate Suno cookie (for self-hosted generation via gcui-art/suno-api)
    // No email verification needed — not financial data
    // PRO PLAN VERIFICATION: When cookie is set, verify via /api/get_limit
    if (suno_cookie !== undefined) {
      if (suno_cookie === null || suno_cookie === "") {
        // Allow clearing the cookie
        updateData.suno_cookie = null;
        updateData.suno_plan_verified = false;
        updateData.suno_plan_type = "unknown";
        changes.push("suno_cookie → cleared");
      } else if (typeof suno_cookie === "string" && suno_cookie.length > 10) {
        const trimmedCookie = suno_cookie.trim().slice(0, 4096);

        // ─── PRO PLAN VERIFICATION ─────────────────────────────────
        // Call Suno's billing API directly with the __session JWT token.
        // This bypasses the suno-api's Clerk session requirement and works
        // as long as the cookie is fresh (submitted within ~1hr of browser login).
        let planVerified = false;
        try {
          // Extract __session JWT from the cookie string
          const sessionMatch = trimmedCookie.match(/(?:^|;\s*)__session=([^;]+)/);
          if (sessionMatch) {
            const sessionJwt = sessionMatch[1];
            const billingRes = await fetch("https://studio-api.prod.suno.com/api/billing/info/", {
              method: "GET",
              headers: {
                "Authorization": `Bearer ${sessionJwt}`,
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
              },
            });

            if (billingRes.ok) {
              const billingData = await billingRes.json();
              // Suno billing API returns monthly_limit (50=free, 2500=pro, 10000=premier)
              const monthlyLimit = billingData.monthly_limit ?? billingData.total_credits_left ?? 0;
              const creditsLeft = billingData.credits_left ?? 0;

              let planType = "free";
              if (monthlyLimit >= 10000) planType = "premier";
              else if (monthlyLimit >= 2500) planType = "pro";

              if (planType === "free") {
                return new Response(
                  JSON.stringify({
                    error: "Suno Free plan detected. MusiClaw requires a Suno Pro or Premier plan for commercial licensing rights. Upgrade at suno.com/account.",
                    monthly_limit: monthlyLimit,
                    credits_left: creditsLeft,
                    plan_detected: "free",
                    required: "pro or premier",
                  }),
                  { status: 403, headers: { ...cors, "Content-Type": "application/json" } }
                );
              }

              updateData.suno_plan_verified = true;
              updateData.suno_plan_type = planType;
              updateData.suno_plan_verified_at = new Date().toISOString();
              changes.push(`suno_plan → ${planType} (verified, monthly_limit: ${monthlyLimit})`);
              planVerified = true;
            } else {
              console.warn(`Suno billing API returned ${billingRes.status} for @${agent.handle}`);
            }
          }

          // Fallback: try via suno-api's /api/get_limit if direct call failed
          if (!planVerified) {
            const { data: agentUrls } = await supabase
              .from("agents").select("suno_self_hosted_url").eq("id", agent.id).single();
            const centralizedUrl = Deno.env.get("SUNO_SELF_HOSTED_URL");
            const verifyUrl = agentUrls?.suno_self_hosted_url || centralizedUrl;

            if (verifyUrl) {
              const limitRes = await fetch(`${verifyUrl}/api/get_limit`, {
                method: "GET",
                headers: { "X-Suno-Cookie": trimmedCookie },
              });
              if (limitRes.ok) {
                const limitData = await limitRes.json();
                const monthlyLimit = limitData.monthly_limit ?? 0;
                let planType = "free";
                if (monthlyLimit >= 10000) planType = "premier";
                else if (monthlyLimit >= 2500) planType = "pro";

                if (planType === "free") {
                  return new Response(
                    JSON.stringify({
                      error: "Suno Free plan detected. MusiClaw requires a Suno Pro or Premier plan for commercial licensing rights. Upgrade at suno.com/account.",
                      monthly_limit: monthlyLimit,
                      plan_detected: "free",
                      required: "pro or premier",
                    }),
                    { status: 403, headers: { ...cors, "Content-Type": "application/json" } }
                  );
                }
                updateData.suno_plan_verified = true;
                updateData.suno_plan_type = planType;
                updateData.suno_plan_verified_at = new Date().toISOString();
                changes.push(`suno_plan → ${planType} (verified via suno-api, monthly_limit: ${monthlyLimit})`);
                planVerified = true;
              }
            }
          }

          if (!planVerified) {
            updateData.suno_plan_verified = false;
            updateData.suno_plan_type = "unknown";
            changes.push("suno_plan → could not verify. Ensure your cookie includes a fresh __session token (log into suno.com and copy cookie immediately).");
          }
        } catch (verifyErr: any) {
          console.error(`Plan verify error for @${agent.handle}:`, verifyErr.message);
          updateData.suno_plan_verified = false;
          updateData.suno_plan_type = "unknown";
          changes.push("suno_plan → verification error. Cookie stored, will re-verify on generation.");
        }

        updateData.suno_cookie = trimmedCookie;
        changes.push("suno_cookie → stored (for self-hosted Suno generation)");
      } else {
        return new Response(
          JSON.stringify({ error: "Invalid suno_cookie format. Must be a string longer than 10 characters." }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
    }

    // Validate self-hosted Suno API URL (for decentralized generation)
    // No email verification needed — not financial data
    if (suno_self_hosted_url !== undefined) {
      if (suno_self_hosted_url === null || suno_self_hosted_url === "") {
        // Allow clearing the URL (fall back to centralized)
        updateData.suno_self_hosted_url = null;
        changes.push("suno_self_hosted_url → cleared (will use centralized, costs G-Credits)");
      } else if (typeof suno_self_hosted_url === "string") {
        const cleanUrl = suno_self_hosted_url.trim().slice(0, 256);
        // Must be HTTPS
        if (!cleanUrl.startsWith("https://")) {
          return new Response(
            JSON.stringify({ error: "suno_self_hosted_url must use HTTPS" }),
            { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
          );
        }
        // Block private/internal URLs (SSRF prevention)
        const urlLower = cleanUrl.toLowerCase();
        if (urlLower.includes("localhost") || urlLower.includes("127.0.0.1") || urlLower.includes("0.0.0.0") || urlLower.includes("169.254.") || urlLower.includes("10.") || urlLower.includes("192.168.") || urlLower.includes(".internal")) {
          return new Response(
            JSON.stringify({ error: "suno_self_hosted_url cannot point to private/internal addresses" }),
            { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
          );
        }
        // Remove trailing slash
        updateData.suno_self_hosted_url = cleanUrl.replace(/\/+$/, "");
        changes.push(`suno_self_hosted_url → ${updateData.suno_self_hosted_url} (your own instance — no G-Credits needed)`);
      } else {
        return new Response(
          JSON.stringify({ error: "Invalid suno_self_hosted_url format. Must be an HTTPS URL." }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
    }

    // Validate LALAL.ai API key (for professional stem splitting)
    // No email verification needed — not financial data
    if (lalal_api_key !== undefined) {
      if (lalal_api_key === null || lalal_api_key === "") {
        updateData.lalal_api_key = null;
        changes.push("lalal_api_key → cleared");
      } else if (typeof lalal_api_key === "string" && lalal_api_key.length >= 10) {
        const trimmedKey = lalal_api_key.trim().slice(0, 256);

        // Verify the key works by checking remaining minutes
        try {
          const verifyRes = await fetch("https://www.lalal.ai/api/v1/limits/minutes_left/", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-License-Key": trimmedKey,
            },
          });

          if (!verifyRes.ok) {
            return new Response(
              JSON.stringify({ error: "Invalid LALAL.ai API key — verification failed. Get yours at lalal.ai/pricing" }),
              { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
            );
          }

          const limitsData = await verifyRes.json();
          updateData.lalal_api_key = trimmedKey;
          changes.push(`lalal_api_key → verified (minutes left: ${JSON.stringify(limitsData)})`);
        } catch (lalalErr: any) {
          console.error(`LALAL.ai verify error for @${agent.handle}:`, lalalErr.message);
          return new Response(
            JSON.stringify({ error: "Could not verify LALAL.ai API key — network error. Try again." }),
            { status: 502, headers: { ...cors, "Content-Type": "application/json" } }
          );
        }
      } else {
        return new Response(
          JSON.stringify({ error: "Invalid lalal_api_key format. Must be a string of at least 10 characters. Get yours at lalal.ai/pricing" }),
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
        message: "Settings updated. " + (updateData.owner_email ? `Owner email set to ${updateData.owner_email} — use this to access the My Agents dashboard. ` : "") + (updateData.paypal_email ? "PayPal connected — you'll receive payouts from sales. " : "") + (updateData.default_beat_price ? `New beats will be priced at $${updateData.default_beat_price}. ` : "") + (suno_cookie !== undefined ? (updateData.suno_cookie ? "Suno cookie stored. " : "Suno cookie cleared. ") : "") + (suno_self_hosted_url !== undefined ? (updateData.suno_self_hosted_url ? `Self-hosted URL set — generations will use your instance (no G-Credits needed). ` : "Self-hosted URL cleared — will use centralized instance (costs G-Credits). ") : "") + (lalal_api_key !== undefined ? (updateData.lalal_api_key ? "LALAL.ai API key stored — stem splitting enabled for your beats. " : "LALAL.ai API key cleared — stem splitting disabled. ") : ""),
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
