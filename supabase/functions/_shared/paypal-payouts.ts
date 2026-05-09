// supabase/functions/_shared/paypal-payouts.ts
// Shared PayPal Payouts helper used by:
//   - capture-order      (beat-sale 80% disbursement)
//   - purchase-sample    (auto-payout when sample balance crosses threshold)
//   - payout-sample-earnings (manual payout via owner dashboard)
//   - retry-failed-payouts   (cron / admin retry)
//
// We keep ONE place that knows how to talk to /v1/oauth2/token and
// /v1/payments/payouts so behavior stays consistent across endpoints
// (idempotent batch IDs, error truncation, retry-friendly response shape).

export async function getPayPalAccessToken(): Promise<string> {
  const clientId = Deno.env.get("PAYPAL_CLIENT_ID");
  const clientSecret = Deno.env.get("PAYPAL_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not configured");
  }
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

export interface SendPayoutInput {
  /** Stable identifier for the row being paid out. Used as the suffix for sender_batch_id. */
  rowId: string;
  /** Attempt number for this row (1 on first try, 2+ on retries). Forms the unique batch ID. */
  attempt: number;
  /** USD amount to send. Will be .toFixed(2)-rounded by PayPal anyway, but pass cleanly. */
  amount: number;
  /** Recipient PayPal email. */
  receiverEmail: string;
  /** "beat" or "sample" — used to namespace the sender_batch_id and email copy. */
  kind: "beat" | "sample" | "sample-auto" | "retry-beat" | "retry-sample";
  /** Subject of the PayPal-sent notification email. */
  emailSubject: string;
  /** Body of the PayPal-sent notification email. */
  emailMessage: string;
}

export interface SendPayoutResult {
  ok: boolean;
  batchId: string | null;
  /** PayPal HTTP status (or 0 if a network error before HTTP). */
  status: number;
  /** Truncated error string when ok=false; null when ok=true. */
  error: string | null;
}

/**
 * Send a single-item PayPal payout. Idempotent across retries because
 * sender_batch_id includes the attempt number — PayPal rejects duplicates
 * on the same batch ID, so a retry that uses attempt+1 cannot accidentally
 * double-pay.
 *
 * Caller is responsible for persisting the result (status, batchId, error,
 * payout_attempts, payout_last_attempt_at) to whichever table this row lives in.
 */
export async function sendPayPalPayout(input: SendPayoutInput): Promise<SendPayoutResult> {
  const apiBase = Deno.env.get("PAYPAL_API_BASE") || "https://api-m.paypal.com";

  let token: string;
  try {
    token = await getPayPalAccessToken();
  } catch (err) {
    return {
      ok: false,
      batchId: null,
      status: 0,
      error: ((err as Error).message || String(err)).slice(0, 800),
    };
  }

  const senderBatchId = `beatclaw-${input.kind}-${input.rowId}-a${input.attempt}`;

  let res: Response;
  try {
    res = await fetch(`${apiBase}/v1/payments/payouts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender_batch_header: {
          sender_batch_id: senderBatchId,
          recipient_type: "EMAIL",
          email_subject: input.emailSubject,
          email_message: input.emailMessage,
        },
        items: [
          {
            amount: { value: input.amount.toFixed(2), currency: "USD" },
            sender_item_id: input.rowId,
            recipient_wallet: "PAYPAL",
            receiver: input.receiverEmail,
          },
        ],
      }),
    });
  } catch (err) {
    return {
      ok: false,
      batchId: null,
      status: 0,
      error: ((err as Error).message || String(err)).slice(0, 800),
    };
  }

  // deno-lint-ignore no-explicit-any
  let data: any = null;
  try {
    data = await res.json();
  } catch (_) {
    // body might be empty / non-JSON on some error responses — that's fine.
  }

  if (res.ok || res.status === 201) {
    return {
      ok: true,
      batchId: data?.batch_header?.payout_batch_id || null,
      status: res.status,
      error: null,
    };
  }

  return {
    ok: false,
    batchId: null,
    status: res.status,
    error: `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 800)}`,
  };
}
