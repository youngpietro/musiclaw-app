// supabase/functions/payout-sample-earnings/index.ts
// POST /functions/v1/payout-sample-earnings
// Body: { email, code, agent_id }
// Pays out accumulated sample earnings to agent's PayPal.
// SECURITY: Rate limited, requires valid email verification code,
//           verifies agent ownership, atomic balance deduction.

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

const MIN_PAYOUT_USD = 5.0;

function getCorsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: cors });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ─── RATE LIMITING: max 5 payout requests per hour per IP ────
    const clientIp =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("cf-connecting-ip") ||
      "unknown";

    const { data: recentAttempts } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "payout_sample_earnings")
      .eq("identifier", clientIp)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentAttempts && recentAttempts.length >= 5) {
      return new Response(
        JSON.stringify({ error: "Too many payout attempts. Try again later." }),
        {
          status: 429,
          headers: { ...cors, "Content-Type": "application/json" },
        }
      );
    }

    await supabase.from("rate_limits").insert({
      action: "payout_sample_earnings",
      identifier: clientIp,
    });

    // ─── PARSE INPUT ─────────────────────────────────────────────
    const body = await req.json();
    const { email, code, agent_id } = body;

    if (!email || typeof email !== "string") {
      return new Response(
        JSON.stringify({ error: "Email is required" }),
        {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        }
      );
    }

    const normalizedEmail = email.trim().toLowerCase();
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(normalizedEmail)) {
      return new Response(
        JSON.stringify({ error: "Invalid email format" }),
        {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        }
      );
    }

    if (!code || typeof code !== "string" || code.length !== 6) {
      return new Response(
        JSON.stringify({
          error: "A 6-digit verification code is required",
        }),
        {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        }
      );
    }

    if (!agent_id || typeof agent_id !== "string") {
      return new Response(
        JSON.stringify({ error: "agent_id is required" }),
        {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        }
      );
    }

    // ─── VERIFY EMAIL CODE ───────────────────────────────────────
    const { data: verification } = await supabase
      .from("email_verifications")
      .select("id, verified")
      .eq("email", normalizedEmail)
      .eq("code", code)
      .eq("verified", true)
      .gte("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!verification) {
      return new Response(
        JSON.stringify({
          error:
            "Invalid or expired verification code. Please request a new code.",
        }),
        {
          status: 403,
          headers: { ...cors, "Content-Type": "application/json" },
        }
      );
    }

    // ─── VERIFY AGENT OWNERSHIP ──────────────────────────────────
    const { data: agent, error: agentErr } = await supabase
      .from("agents")
      .select("id, name, handle, paypal_email, pending_sample_earnings")
      .eq("id", agent_id)
      .eq("owner_email", normalizedEmail)
      .single();

    if (agentErr || !agent) {
      return new Response(
        JSON.stringify({ error: "Agent not found for this email." }),
        {
          status: 403,
          headers: { ...cors, "Content-Type": "application/json" },
        }
      );
    }

    // ─── VALIDATE PAYOUT ELIGIBILITY ─────────────────────────────
    if (!agent.paypal_email) {
      return new Response(
        JSON.stringify({
          error:
            "No PayPal email configured for this agent. Set it via update-agent-settings.",
        }),
        {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        }
      );
    }

    const pendingAmount = parseFloat(agent.pending_sample_earnings || "0");
    if (pendingAmount < MIN_PAYOUT_USD) {
      return new Response(
        JSON.stringify({
          error: `Minimum payout is $${MIN_PAYOUT_USD.toFixed(2)}. Current balance: $${pendingAmount.toFixed(2)}`,
        }),
        {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        }
      );
    }

    const payoutAmount =
      Math.round(pendingAmount * 100) / 100;

    // ─── ATOMIC BALANCE DEDUCTION ────────────────────────────────
    const { data: deductSuccess, error: rpcErr } = await supabase.rpc(
      "process_sample_payout",
      {
        p_agent_id: agent_id,
        p_amount: payoutAmount,
      }
    );

    if (rpcErr || !deductSuccess) {
      return new Response(
        JSON.stringify({
          error:
            "Balance changed. Please refresh your dashboard and try again.",
        }),
        {
          status: 409,
          headers: { ...cors, "Content-Type": "application/json" },
        }
      );
    }

    // ─── CREATE PAYOUT RECORD ────────────────────────────────────
    const { data: payoutRecord, error: insertErr } = await supabase
      .from("sample_payouts")
      .insert({
        agent_id: agent_id,
        owner_email: normalizedEmail,
        amount: payoutAmount,
        paypal_email: agent.paypal_email,
        status: "pending",
      })
      .select("id")
      .single();

    if (insertErr || !payoutRecord) {
      // Refund: restore the deducted amount
      await supabase.rpc("increment_agent_sample_earnings", {
        p_agent_id: agent_id,
        p_amount: payoutAmount,
      });
      console.error("Failed to create payout record:", insertErr?.message);
      return new Response(
        JSON.stringify({
          error: "Failed to create payout record. Balance restored.",
        }),
        {
          status: 500,
          headers: { ...cors, "Content-Type": "application/json" },
        }
      );
    }

    // ─── SEND PAYPAL PAYOUT (via shared helper) ──────────────────
    const agentName = agent.name || agent.handle || "Agent";
    const nowIso = new Date().toISOString();

    const result = await sendPayPalPayout({
      rowId: payoutRecord.id,
      attempt: 1,
      amount: payoutAmount,
      receiverEmail: agent.paypal_email,
      kind: "sample",
      emailSubject: `You earned $${payoutAmount.toFixed(2)} from sample sales — BeatClaw`,
      emailMessage: `Sample earnings for "${agentName}" have been sent to your PayPal account.`,
    });

    if (result.ok) {
      await supabase
        .from("sample_payouts")
        .update({
          paypal_batch_id: result.batchId,
          status: "sent",
          payout_attempts: 1,
          payout_last_attempt_at: nowIso,
          payout_error: null,
        })
        .eq("id", payoutRecord.id);

      console.log(
        `Sample payout sent: $${payoutAmount.toFixed(2)} to ${agent.paypal_email} for agent ${agent_id} (batch: ${result.batchId})`
      );

      // Create invoice record (non-fatal if it fails)
      try {
        const { data: invoiceData } = await supabase.rpc("create_invoice", {
          p_data: {
            type: "sample_payout",
            seller_email: agent.paypal_email,
            amount: String(payoutAmount),
            seller_amount: String(payoutAmount),
            line_items: [
              { description: `Sample earnings payout for "${agentName}"`, quantity: 1, unit_price: payoutAmount },
            ],
            paypal_payout_batch_id: result.batchId || "",
            sample_payout_id: payoutRecord.id,
            notes: `Payout to ${agent.paypal_email}.`,
          },
        });
        console.log(`Invoice created: ${invoiceData?.invoice_number} for payout ${payoutRecord.id}`);
      } catch (invErr: unknown) {
        console.error("Invoice creation error:", (invErr as Error).message);
      }

      return new Response(
        JSON.stringify({
          success: true,
          payout_amount: payoutAmount,
          paypal_batch_id: result.batchId,
          agent_name: agentName,
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    } else {
      // PayPal rejected OR network/auth error — log + refund balance
      const newStatus = result.status === 0 ? "error" : "failed";
      console.error(`Sample payout ${newStatus}:`, result.error);

      await supabase
        .from("sample_payouts")
        .update({
          status: newStatus,
          payout_attempts: 1,
          payout_last_attempt_at: nowIso,
          payout_error: result.error,
        })
        .eq("id", payoutRecord.id);

      // Restore the deducted amount
      await supabase.rpc("increment_agent_sample_earnings", {
        p_agent_id: agent_id,
        p_amount: payoutAmount,
      });

      const userMsg = newStatus === "error"
        ? "Payment service unavailable. Your balance has been restored. Please try again later."
        : "PayPal payout failed. Your balance has been restored. Please try again later.";

      return new Response(
        JSON.stringify({ error: userMsg }),
        { status: 502, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("Payout sample earnings error:", errMsg);
    return new Response(
      JSON.stringify({
        error: "Payout request failed. Please try again.",
      }),
      {
        status: 500,
        headers: {
          ...getCorsHeaders(req),
          "Content-Type": "application/json",
        },
      }
    );
  }
});
