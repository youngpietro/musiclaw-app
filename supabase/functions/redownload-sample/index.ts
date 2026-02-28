// supabase/functions/redownload-sample/index.ts
// POST /functions/v1/redownload-sample
// Body: { sample_id }
// Regenerates a download token for a previously purchased sample.
// Resets download_count and extends expiry by 24 hours.
// SECURITY: Requires Supabase Auth JWT, only works for samples the user has purchased.

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

async function hmacSign(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const bytes = new Uint8Array(signature);
  let b64 = btoa(String.fromCharCode(...bytes));
  b64 = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return b64;
}

serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const signingSecret = Deno.env.get("DOWNLOAD_SIGNING_SECRET");

    if (!signingSecret) {
      console.error("DOWNLOAD_SIGNING_SECRET not configured");
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── AUTHENTICATE USER ──────────────────────────────────────────
    const authHeader = req.headers.get("authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Authentication required. Please log in." }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired session. Please log in again." }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // ─── VALIDATE INPUT ─────────────────────────────────────────────
    const body = await req.json();
    const { sample_id } = body;

    if (!sample_id) {
      return new Response(
        JSON.stringify({ error: "sample_id is required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── LOOK UP PURCHASE ───────────────────────────────────────────
    const { data: purchase } = await supabase
      .from("sample_purchases")
      .select("id, sample_id")
      .eq("sample_id", sample_id)
      .eq("user_id", user.id)
      .single();

    if (!purchase) {
      return new Response(
        JSON.stringify({ error: "You haven't purchased this sample" }),
        { status: 404, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── GENERATE NEW TOKEN ─────────────────────────────────────────
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    const tokenPayload = `sample:${sample_id}:${user.id}:${expiresAt.toISOString()}`;
    const signature = await hmacSign(tokenPayload, signingSecret);
    const downloadToken = btoa(tokenPayload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") +
      "." + signature;

    // ─── UPDATE PURCHASE RECORD ─────────────────────────────────────
    await supabase
      .from("sample_purchases")
      .update({
        download_token: downloadToken,
        download_expires: expiresAt.toISOString(),
        download_count: 0,
      })
      .eq("id", purchase.id);

    const downloadUrl = `${supabaseUrl}/functions/v1/download-sample?token=${encodeURIComponent(downloadToken)}`;

    console.log(`Redownload token generated for sample ${sample_id} by user ${user.id}`);

    return new Response(
      JSON.stringify({
        success: true,
        download_url: downloadUrl,
        download_token: downloadToken,
        download_expires: expiresAt.toISOString(),
        expires_in: "24 hours",
        max_downloads: 5,
      }),
      { headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Redownload sample error:", err.message);
    return new Response(
      JSON.stringify({ error: "Failed to generate download link. Please try again." }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
