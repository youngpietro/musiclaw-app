// _shared/invoice-email.ts
// Reusable invoice-style email HTML builder for MusiClaw payment receipts.

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unit_price: number;
}

export interface InvoiceEmailParams {
  invoiceNumber: string;
  title: string;              // e.g. "Purchase Complete!", "Credits Purchased!", "Payout Sent!"
  lineItems: InvoiceLineItem[];
  total: number;
  currency?: string;          // default "USD"
  paypalOrderId?: string;
  paypalBatchId?: string;     // for payouts
  date: string;               // formatted date string
  accentColor?: string;       // default "#22c55e" (green)
  extraHtml?: string;         // download button, balance info, etc. (injected after line items)
  footerNote?: string;        // e.g. "Commercial license included."
  platformFee?: number;       // shown only for beat purchases (agent email)
  sellerAmount?: number;      // shown only for beat purchases (agent email)
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build a styled invoice email in MusiClaw's dark theme.
 */
export function buildInvoiceEmail(params: InvoiceEmailParams): string {
  const {
    invoiceNumber,
    title,
    lineItems,
    total,
    currency = "USD",
    paypalOrderId,
    paypalBatchId,
    date,
    accentColor = "#22c55e",
    extraHtml = "",
    footerNote = "",
    platformFee,
    sellerAmount,
  } = params;

  const itemRows = lineItems
    .map(
      (item) => `
      <tr>
        <td style="padding:8px 0;color:rgba(255,255,255,0.8);border-bottom:1px solid rgba(255,255,255,0.08);">
          ${esc(item.description)}
        </td>
        <td style="padding:8px 0;color:rgba(255,255,255,0.8);text-align:right;border-bottom:1px solid rgba(255,255,255,0.08);white-space:nowrap;">
          ${item.quantity > 1 ? `${item.quantity} × ` : ""}$${item.unit_price.toFixed(2)}
        </td>
      </tr>`
    )
    .join("");

  const feeRows =
    platformFee != null && sellerAmount != null
      ? `
      <tr>
        <td style="padding:4px 0;color:rgba(255,255,255,0.4);font-size:12px;">Platform fee (20%)</td>
        <td style="padding:4px 0;color:rgba(255,255,255,0.4);font-size:12px;text-align:right;">-$${platformFee.toFixed(2)}</td>
      </tr>
      <tr>
        <td style="padding:4px 0;color:rgba(255,255,255,0.4);font-size:12px;">Your earnings</td>
        <td style="padding:4px 0;color:#22c55e;font-size:12px;text-align:right;">$${sellerAmount.toFixed(2)}</td>
      </tr>`
      : "";

  const refId = paypalOrderId
    ? `PayPal Order: ${esc(paypalOrderId)}`
    : paypalBatchId
    ? `PayPal Payout: ${esc(paypalBatchId)}`
    : "";

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;background:#0e0e14;color:#f0f0f0;padding:32px;border-radius:16px;">

      <h1 style="color:${accentColor};font-size:24px;margin:0 0 4px;">${esc(title)}</h1>
      <p style="color:rgba(255,255,255,0.35);font-size:12px;margin:0 0 20px;">
        Invoice ${esc(invoiceNumber)} &bull; ${esc(date)}
      </p>

      <table style="width:100%;border-collapse:collapse;margin:0 0 16px;">
        ${itemRows}
        ${feeRows}
        <tr>
          <td style="padding:12px 0 0;color:#ffffff;font-weight:700;font-size:16px;">Total</td>
          <td style="padding:12px 0 0;color:${accentColor};font-weight:700;font-size:16px;text-align:right;">
            $${total.toFixed(2)} ${esc(currency)}
          </td>
        </tr>
      </table>

      ${extraHtml}

      ${
        refId || footerNote
          ? `<div style="margin-top:20px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.08);">
              ${footerNote ? `<p style="color:rgba(255,255,255,0.5);font-size:12px;margin:0 0 4px;">${esc(footerNote)}</p>` : ""}
              ${refId ? `<p style="color:rgba(255,255,255,0.3);font-size:11px;margin:0;">${refId}</p>` : ""}
            </div>`
          : ""
      }

      <p style="color:rgba(255,255,255,0.2);font-size:11px;margin-top:24px;">
        MusiClaw.app &mdash; Where AI agents find their voice
      </p>
    </div>
  `;
}
