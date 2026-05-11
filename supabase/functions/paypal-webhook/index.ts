// supabase/functions/paypal-webhook/index.ts
// POST /functions/v1/paypal-webhook
// Receives PayPal webhook events. Verifies signature, deduplicates by event_id,
// then forwards order/capture events to capture-order so a buyer who closes
// the tab mid-checkout (or hits a flaky network on onApprove) still gets their
// beat AND the agent still gets their payout.
//
// Subscribed events (configure in PayPal dashboard for the same app whose
// PAYPAL_CLIENT_ID this project uses):
//   - CHECKOUT.ORDER.APPROVED       → primary: drive capture if SPA didn't
//   - PAYMENT.CAPTURE.COMPLETED     → safety net: confirm capture happened
//
// Required env (set via `supabase secrets set` or the dashboard):
//   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET   (already set, used for OAuth)
//   PAYPAL_API_BASE                          (defaults to live)
//   PAYPAL_WEBHOOK_ID                        (NEW — from PayPal dashboard
//                                             webhook page; PayPal generates
//                                             this when you register the
//                                             webhook URL)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (already set, auto-injected)
//   INTERNAL_WEBHOOK_SECRET                  (NEW — random hex string;
//                                             shared with capture-order so
//                                             it can recognize our internal
//                                             call and bypass rate-limiting)
//
// IMPORTANT: deploy this function with `--no-verify-jwt`. PayPal won't send
// a Supabase JWT — signature verification IS the auth gate.
//
//   supabase functions deploy paypal-webhook --no-verify-jwt
//
// Webhook URL to register in PayPal dashboard:
//   https://<project-ref>.supabase.co/functions/v1/paypal-webhook

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

async function getPayPalAccessToken(): Promise<string> {
  const clientId = Deno.env.get("PAYPAL_CLIENT_ID")!;
  const clientSecret = Deno.env.get("PAYPAL_CLIENT_SECRET")!;
  const apiBase = Deno.env.get("PAYPAL_API_BASE") || "https://api-m.paypal.com";

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

async function verifyWebhookSignature(
  req: Request,
  rawBody: string
): Promise<boolean> {
  const webhookId = Deno.env.get("PAYPAL_WEBHOOK_ID");
  if (!webhookId) {
    console.error("PAYPAL_WEBHOOK_ID not set — cannot verify signature.");
    return false;
  }

  const transmissionId = req.headers.get("paypal-transmission-id");
  const transmissionTime = req.headers.get("paypal-transmission-time");
  const transmissionSig = req.headers.get("paypal-transmission-sig");
  const certUrl = req.headers.get("paypal-cert-url");
  const authAlgo = req.headers.get("paypal-auth-algo");

  if (
    !transmissionId ||
    !transmissionTime ||
    !transmissionSig ||
    !certUrl ||
    !authAlgo
  ) {
    console.error("Missing PayPal signature headers");
    return false;
  }

  const apiBase = Deno.env.get("PAYPAL_API_BASE") || "https://api-m.paypal.com";
  const accessToken = await getPayPalAccessToken();

  // PayPal's verify-webhook-signature endpoint takes the parsed event back —
  // it re-serializes internally and checks the signature against the canonical
  // form. We pass the parsed JSON.
  const verifyRes = await fetch(
    `${apiBase}/v1/notifications/verify-webhook-signature`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: webhookId,
        webhook_event: JSON.parse(rawBody),
      }),
    }
  );

  if (!verifyRes.ok) {
    const errText = await verifyRes.text();
    console.error(
      "verify-webhook-signature HTTP error:",
      verifyRes.status,
      errText.slice(0, 500)
    );
    return false;
  }
  const verifyData = await verifyRes.json();
  if (verifyData.verification_status !== "SUCCESS") {
    // Capture every diagnostic header so we can tell the difference between
    // PayPal's simulator (notoriously fails this check) and a real event with
    // a real bug. cert_url is the most useful signal — simulator/sandbox certs
    // start with the sandbox host, real prod events with live host.
    console.error(
      "verify-webhook-signature rejected:",
      verifyData.verification_status,
      "| cert_url:", certUrl,
      "| transmission_id:", transmissionId,
      "| webhook_id used:", webhookId,
      "| full response:", JSON.stringify(verifyData)
    );
    return false;
  }
  return true;
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // Read raw body BEFORE any JSON parse — PayPal may sign on byte-exact form.
  // We then parse a separate copy for our own use.
  const rawBody = await req.text();

  // ─── VERIFY SIGNATURE ──────────────────────────────────────────────
  const verified = await verifyWebhookSignature(req, rawBody).catch((err) => {
    console.error("Signature verify threw:", (err as Error).message);
    return false;
  });

  if (!verified) {
    return new Response(JSON.stringify({ error: "invalid signature" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // deno-lint-ignore no-explicit-any
  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const eventId: string | undefined = event.id;
  const eventType: string | undefined = event.event_type;
  if (!eventId || !eventType) {
    return new Response("missing id/event_type", { status: 400 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // ─── EXTRACT ORDER ID FROM EVENT ───────────────────────────────────
  // CHECKOUT.ORDER.*           → resource.id = order_id
  // PAYMENT.CAPTURE.*          → resource.id = capture_id;
  //                              order_id lives at supplementary_data.related_ids.order_id
  let orderId: string | null = null;
  if (eventType.startsWith("CHECKOUT.ORDER.")) {
    orderId = event.resource?.id ?? null;
  } else if (eventType.startsWith("PAYMENT.CAPTURE.")) {
    orderId =
      event.resource?.supplementary_data?.related_ids?.order_id ?? null;
  }

  // ─── IDEMPOTENCY: insert event with conflict-handling ──────────────
  const { error: insertErr } = await supabase
    .from("paypal_webhook_events")
    .insert({
      event_id: eventId,
      event_type: eventType,
      resource_id: orderId,
      raw_event: event,
    });

  if (insertErr) {
    // 23505 = unique-violation on event_id PK → already processed.
    // Return 200 so PayPal stops retrying.
    // deno-lint-ignore no-explicit-any
    if ((insertErr as any).code === "23505") {
      console.log(
        `Webhook: duplicate ${eventType} ${eventId} — already handled`
      );
      return new Response(
        JSON.stringify({ ok: true, duplicate: true }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    // Some other DB error — log but continue. We'd rather process the
    // event than reject and force PayPal to retry.
    console.error(
      "Failed to record webhook event:",
      insertErr.message,
      // deno-lint-ignore no-explicit-any
      (insertErr as any).code
    );
  }

  // ─── HANDLE EVENT ──────────────────────────────────────────────────
  let processError: string | null = null;
  try {
    const isCheckoutApproved = eventType === "CHECKOUT.ORDER.APPROVED";
    const isCaptureCompleted = eventType === "PAYMENT.CAPTURE.COMPLETED";

    if (!isCheckoutApproved && !isCaptureCompleted) {
      console.log(`Webhook: ignoring unsubscribed event type ${eventType}`);
    } else if (!orderId) {
      processError = `event ${eventType} missing order id`;
      console.warn(processError);
    } else {
      // Look up the purchase row. If not found, we have a webhook for an
      // order that was never created via our create-order — log and ignore.
      const { data: purchase } = await supabase
        .from("purchases")
        .select("paypal_status")
        .eq("paypal_order_id", orderId)
        .maybeSingle();

      if (!purchase) {
        processError = `no purchase row for order ${orderId}`;
        console.warn(`Webhook ${eventType} for ${orderId}: ${processError}`);
      } else if (purchase.paypal_status === "completed") {
        // Already captured (likely the SPA's onApprove handler beat us).
        // Nothing to do — capture-order is idempotent on this state, but
        // skip the round-trip.
        console.log(`Webhook: ${orderId} already completed, no-op`);
      } else if (purchase.paypal_status !== "pending") {
        // Failed/refunded/etc. — don't re-trigger capture.
        processError = `order ${orderId} status='${purchase.paypal_status}', not capturing`;
        console.warn(processError);
      } else {
        // Forward to capture-order using the shared internal secret.
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const internalSecret = Deno.env.get("INTERNAL_WEBHOOK_SECRET");
        if (!internalSecret) {
          processError = "INTERNAL_WEBHOOK_SECRET not configured";
          console.error(processError);
        } else {
          const captureRes = await fetch(
            `${supabaseUrl}/functions/v1/capture-order`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${serviceRole}`,
                apikey: serviceRole,
                "X-Internal-Trigger": "paypal-webhook",
                "X-Internal-Webhook-Secret": internalSecret,
              },
              body: JSON.stringify({ order_id: orderId }),
            }
          );
          if (!captureRes.ok) {
            const errText = await captureRes.text();
            processError = `capture-order ${captureRes.status}: ${errText.slice(0, 500)}`;
            console.error(`Webhook → capture-order failed: ${processError}`);
          } else {
            console.log(
              `Webhook ${eventType} → capture-order success for ${orderId}`
            );
          }
        }
      }
    }
  } catch (err) {
    processError = (err as Error).message;
    console.error("Webhook process error:", processError);
  }

  // Mark event processed (or with error) for forensics.
  await supabase
    .from("paypal_webhook_events")
    .update({
      processed_at: new Date().toISOString(),
      process_error: processError,
    })
    .eq("event_id", eventId);

  // Always 200 once signature is verified — PayPal stops retrying on success.
  // Internal handler errors are recorded in paypal_webhook_events for later
  // replay rather than rejected (which would cause PayPal to keep retrying
  // the same problematic event for ~3 days).
  return new Response(JSON.stringify({ ok: !processError }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
