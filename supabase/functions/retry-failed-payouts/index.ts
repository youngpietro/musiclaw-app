// supabase/functions/retry-failed-payouts/index.ts
// POST /functions/v1/retry-failed-payouts
//
// Two callers:
//   1. pg_cron (nightly)        — sends X-Retry-Source: cron + the cron secret
//   2. owner-dashboard "Retry"  — sends { email, code, agent_id } verified path
//
// Picks failed/error rows in `purchases` and `sample_payouts` whose
// payout_attempts < MAX_ATTEMPTS, retries each via shared PayPal helper,
// and updates state. Idempotent because each retry uses a fresh
// sender_batch_id (rowId + attempt suffix).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendPayPalPayout } from "../_shared/paypal-payouts.ts";

const ALLOWED_ORIGINS = [
  "https://beatclaw.com",
  "https://www.beatclaw.com",
  "https://musiclaw.app",
  "https://www.musiclaw.app",
  "https://musiclaw-app.vercel.app",
];

// Hard caps to avoid runaway retries.
const MAX_ATTEMPTS = 5;
// How many rows the cron can process per invocation. Caps PayPal API load.
const BATCH_SIZE = 50;
// Don't retry rows newer than this — they were just attempted by the
// originating function, give it a chance to settle before re-trying.
const MIN_AGE_MINUTES = 15;
// Don't retry rows older than this — assume manual intervention is needed.
const MAX_AGE_DAYS = 60;

function getCorsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-retry-source, x-cron-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

interface RetryStats {
  scanned: number;
  retried: number;
  succeeded: number;
  failed: number;
  skipped: number;
  errors: string[];
}

// deno-lint-ignore no-explicit-any
async function retryBeatPayouts(supabase: any, agentId: string | null): Promise<RetryStats> {
  const stats: RetryStats = { scanned: 0, retried: 0, succeeded: 0, failed: 0, skipped: 0, errors: [] };

  const minAgeIso = new Date(Date.now() - MIN_AGE_MINUTES * 60 * 1000).toISOString();
  const maxAgeIso = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from("purchases")
    .select("id, beat_id, amount, platform_fee, seller_paypal, payout_amount, payout_attempts, payout_last_attempt_at, beats!inner(title, agent_id)")
    .in("payout_status", ["failed", "error"])
    .lt("payout_attempts", MAX_ATTEMPTS)
    .lte("payout_last_attempt_at", minAgeIso)
    .gte("payout_last_attempt_at", maxAgeIso)
    .order("payout_last_attempt_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (agentId) {
    query = query.eq("beats.agent_id", agentId);
  }

  const { data: rows, error } = await query;
  if (error) {
    stats.errors.push(`beat scan: ${error.message}`);
    return stats;
  }

  stats.scanned = rows?.length || 0;
  for (const row of rows || []) {
    if (!row.seller_paypal) {
      stats.skipped++;
      continue;
    }
    const amount = row.payout_amount
      ? parseFloat(row.payout_amount)
      : Math.round((parseFloat(row.amount) - parseFloat(row.platform_fee || "0")) * 100) / 100;
    if (!(amount > 0)) {
      stats.skipped++;
      continue;
    }

    const nextAttempt = ((row.payout_attempts as number) || 0) + 1;
    const nowIso = new Date().toISOString();
    const beatTitle = row.beats?.title || "Beat";

    const result = await sendPayPalPayout({
      rowId: row.id,
      attempt: nextAttempt,
      amount,
      receiverEmail: row.seller_paypal,
      kind: "retry-beat",
      emailSubject: `You earned $${amount.toFixed(2)} from "${beatTitle}" — BeatClaw`,
      emailMessage: `Retried payout for "${beatTitle}". Earnings sent to your PayPal.`,
    });

    stats.retried++;

    if (result.ok) {
      stats.succeeded++;
      await supabase
        .from("purchases")
        .update({
          payout_batch_id: result.batchId,
          payout_status: "sent",
          payout_attempts: nextAttempt,
          payout_last_attempt_at: nowIso,
          payout_error: null,
        })
        .eq("id", row.id);
    } else {
      stats.failed++;
      await supabase
        .from("purchases")
        .update({
          payout_status: result.status === 0 ? "error" : "failed",
          payout_attempts: nextAttempt,
          payout_last_attempt_at: nowIso,
          payout_error: result.error,
        })
        .eq("id", row.id);
    }
  }

  return stats;
}

// deno-lint-ignore no-explicit-any
async function retrySamplePayouts(supabase: any, agentId: string | null): Promise<RetryStats> {
  const stats: RetryStats = { scanned: 0, retried: 0, succeeded: 0, failed: 0, skipped: 0, errors: [] };

  const minAgeIso = new Date(Date.now() - MIN_AGE_MINUTES * 60 * 1000).toISOString();
  const maxAgeIso = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from("sample_payouts")
    .select("id, agent_id, amount, paypal_email, payout_attempts, payout_last_attempt_at, agents!inner(name, handle)")
    .in("status", ["failed", "error"])
    .lt("payout_attempts", MAX_ATTEMPTS)
    .lte("payout_last_attempt_at", minAgeIso)
    .gte("payout_last_attempt_at", maxAgeIso)
    .order("payout_last_attempt_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (agentId) {
    query = query.eq("agent_id", agentId);
  }

  const { data: rows, error } = await query;
  if (error) {
    stats.errors.push(`sample scan: ${error.message}`);
    return stats;
  }

  stats.scanned = rows?.length || 0;
  for (const row of rows || []) {
    if (!row.paypal_email) {
      stats.skipped++;
      continue;
    }
    const amount = parseFloat(row.amount);
    if (!(amount > 0)) {
      stats.skipped++;
      continue;
    }

    const nextAttempt = ((row.payout_attempts as number) || 0) + 1;
    const nowIso = new Date().toISOString();
    const agentName = row.agents?.name || row.agents?.handle || "Agent";

    const result = await sendPayPalPayout({
      rowId: row.id,
      attempt: nextAttempt,
      amount,
      receiverEmail: row.paypal_email,
      kind: "retry-sample",
      emailSubject: `You earned $${amount.toFixed(2)} from sample sales — BeatClaw`,
      emailMessage: `Retried sample-earnings payout for "${agentName}". Earnings sent to your PayPal.`,
    });

    stats.retried++;

    if (result.ok) {
      stats.succeeded++;
      await supabase
        .from("sample_payouts")
        .update({
          paypal_batch_id: result.batchId,
          status: "sent",
          payout_attempts: nextAttempt,
          payout_last_attempt_at: nowIso,
          payout_error: null,
        })
        .eq("id", row.id);
    } else {
      stats.failed++;
      await supabase
        .from("sample_payouts")
        .update({
          status: result.status === 0 ? "error" : "failed",
          payout_attempts: nextAttempt,
          payout_last_attempt_at: nowIso,
          payout_error: result.error,
        })
        .eq("id", row.id);
    }
  }

  return stats;
}

serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "POST only" }),
      { status: 405, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const retrySource = req.headers.get("x-retry-source") || "";
    const cronSecret = req.headers.get("x-cron-secret") || "";

    let agentScope: string | null = null; // null = all agents (cron); set = single agent (owner)

    if (retrySource === "cron") {
      // ─── CRON PATH ──────────────────────────────────────────────
      // Auth: cron must present the configured secret. Without it, anyone
      // could DoS the PayPal API.
      const expected = Deno.env.get("PAYOUT_RETRY_CRON_SECRET");
      if (!expected || cronSecret !== expected) {
        return new Response(
          JSON.stringify({ error: "Unauthorized cron caller" }),
          { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
    } else {
      // ─── OWNER PATH ─────────────────────────────────────────────
      // Auth: owner email + 6-digit verified code, just like other dashboard ops.
      let body: { email?: string; code?: string; agent_id?: string } = {};
      try { body = await req.json(); } catch (_) { /* empty body */ }
      const { email, code, agent_id } = body;

      if (!email || !code || !agent_id) {
        return new Response(
          JSON.stringify({ error: "email, code, and agent_id are required for owner-initiated retries" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      const normalizedEmail = String(email).trim().toLowerCase();

      // Verify code
      const { data: verification } = await supabase
        .from("email_verifications")
        .select("id")
        .eq("email", normalizedEmail)
        .eq("code", code)
        .eq("verified", true)
        .gte("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      if (!verification) {
        return new Response(
          JSON.stringify({ error: "Invalid or expired verification code" }),
          { status: 403, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Verify agent ownership
      const { data: agent } = await supabase
        .from("agents")
        .select("id")
        .eq("id", agent_id)
        .eq("owner_email", normalizedEmail)
        .single();
      if (!agent) {
        return new Response(
          JSON.stringify({ error: "Agent not found for this email" }),
          { status: 403, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      agentScope = agent.id;
    }

    const beatStats = await retryBeatPayouts(supabase, agentScope);
    const sampleStats = await retrySamplePayouts(supabase, agentScope);

    console.log(
      `retry-failed-payouts source=${retrySource || "owner"} scope=${agentScope || "all"} ` +
      `beat=${JSON.stringify(beatStats)} sample=${JSON.stringify(sampleStats)}`
    );

    return new Response(
      JSON.stringify({
        success: true,
        source: retrySource || "owner",
        agent_id: agentScope,
        beat_payouts: beatStats,
        sample_payouts: sampleStats,
      }),
      { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("retry-failed-payouts error:", (err as Error).message);
    return new Response(
      JSON.stringify({ error: "Retry failed. Check function logs." }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
