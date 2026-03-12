// supabase/functions/payout-sample-earnings/index.ts
// POST /functions/v1/payout-sample-earnings
// Body: { email, code, agent_id }
// Pays out accumulated sample earnings to agent's PayPal.
// SECURITY: Rate limited, requires valid email verification code,
//           verifies agent ownership, atomic balance deduction.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
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

async function getPayPalAccessToken(): Promise<string> {
  const clientId = Deno.env.get("PAYPAL_CLIENT_ID")!;
  const clientSecret = Deno.env.get("PAYPAL_CLIENT_SECRET")!;
  const apiBase =
    Deno.env.get("PAYPAL_API_BASE") || "https://api-m.paypal.com";

  const res = await fetch(`${apiBase}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
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

    // ─── SEND PAYPAL PAYOUT ──────────────────────────────────────
    try {
      const accessToken = await getPayPalAccessToken();
      const apiBase =
        Deno.env.get("PAYPAL_API_BASE") ||
        "https://api-m.paypal.com";

      const agentName = agent.name || agent.handle || "Agent";

      const payoutRes = await fetch(`${apiBase}/v1/payments/payouts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sender_batch_header: {
            sender_batch_id: `musiclaw-sample-${payoutRecord.id}`,
            recipient_type: "EMAIL",
            email_subject: `You earned $${payoutAmount.toFixed(2)} from sample sales — MusiClaw`,
            email_message: `Sample earnings for "${agentName}" have been sent to your PayPal account.`,
          },
          items: [
            {
              amount: {
                value: payoutAmount.toFixed(2),
                currency: "USD",
              },
              sender_item_id: payoutRecord.id,
              recipient_wallet: "PAYPAL",
              receiver: agent.paypal_email,
            },
          ],
        }),
      });

      const payoutData = await payoutRes.json();

      if (payoutRes.ok || payoutRes.status === 201) {
        // ── SUCCESS ──
        const batchId =
          payoutData?.batch_header?.payout_batch_id || null;

        await supabase
          .from("sample_payouts")
          .update({ paypal_batch_id: batchId, status: "sent" })
          .eq("id", payoutRecord.id);

        console.log(
          `Sample payout sent: $${payoutAmount.toFixed(2)} to ${agent.paypal_email} for agent ${agent_id} (batch: ${batchId})`
        );

        return new Response(
          JSON.stringify({
            success: true,
            payout_amount: payoutAmount,
            paypal_batch_id: batchId,
            agent_name: agentName,
          }),
          {
            status: 200,
            headers: { ...cors, "Content-Type": "application/json" },
          }
        );
      } else {
        // ── PAYPAL REJECTED — refund balance ──
        console.error(
          "PayPal payout failed:",
          JSON.stringify(payoutData)
        );

        await supabase
          .from("sample_payouts")
          .update({ status: "failed" })
          .eq("id", payoutRecord.id);

        // Restore the deducted amount
        await supabase.rpc("increment_agent_sample_earnings", {
          p_agent_id: agent_id,
          p_amount: payoutAmount,
        });

        return new Response(
          JSON.stringify({
            error:
              "PayPal payout failed. Your balance has been restored. Please try again later.",
          }),
          {
            status: 502,
            headers: { ...cors, "Content-Type": "application/json" },
          }
        );
      }
    } catch (payoutErr: unknown) {
      // ── NETWORK / AUTH ERROR — refund balance ──
      const errMsg = payoutErr instanceof Error ? payoutErr.message : String(payoutErr);
      console.error("Payout error:", errMsg);

      await supabase
        .from("sample_payouts")
        .update({ status: "error" })
        .eq("id", payoutRecord.id);

      // Restore the deducted amount
      await supabase.rpc("increment_agent_sample_earnings", {
        p_agent_id: agent_id,
        p_amount: payoutAmount,
      });

      return new Response(
        JSON.stringify({
          error:
            "Payment service unavailable. Your balance has been restored. Please try again later.",
        }),
        {
          status: 502,
          headers: { ...cors, "Content-Type": "application/json" },
        }
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
