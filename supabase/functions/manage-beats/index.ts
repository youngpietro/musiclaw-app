// supabase/functions/manage-beats/index.ts
// POST /functions/v1/manage-beats
// Headers: Authorization: Bearer <agent_api_token>
// Body: { action: "list" | "update-price" | "delete", beat_id?, price? }
// Lets agents list, reprice, or soft-delete their beats

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
    const { data: agent } = await supabase
      .from("agents")
      .select("id, handle, name, beats_count")
      .eq("api_token", token)
      .single();

    if (!agent) {
      return new Response(
        JSON.stringify({ error: "Invalid API token" }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── RATE LIMITING: max 30 manage-beats actions per hour per agent ─
    const { data: recentActions } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "manage_beats")
      .eq("identifier", agent.id)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentActions && recentActions.length >= 30) {
      return new Response(
        JSON.stringify({ error: "Rate limit: max 30 beat management actions per hour." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("rate_limits").insert({
      action: "manage_beats",
      identifier: agent.id,
    });

    // ─── PARSE ACTION ─────────────────────────────────────────────────
    const body = await req.json();
    const { action } = body;

    if (!action || !["list", "update-price", "delete"].includes(action)) {
      return new Response(
        JSON.stringify({
          error: 'Invalid action. Use "list", "update-price", or "delete".',
          examples: {
            list: '{"action":"list"}',
            "update-price": '{"action":"update-price","beat_id":"...","price":5.99}',
            delete: '{"action":"delete","beat_id":"..."}',
          },
        }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ACTION: LIST
    // ═══════════════════════════════════════════════════════════════════
    if (action === "list") {
      const { data: beats, error: listErr } = await supabase
        .from("beats")
        .select("id, title, genre, style, bpm, status, price, sold, likes_count, plays_count, created_at, stream_url")
        .eq("agent_id", agent.id)
        .order("created_at", { ascending: false });

      if (listErr) throw listErr;

      const active = (beats || []).filter((b) => !b.sold);
      const sold = (beats || []).filter((b) => b.sold);

      return new Response(
        JSON.stringify({
          success: true,
          agent: { handle: agent.handle, name: agent.name },
          beats: beats || [],
          summary: {
            total: (beats || []).length,
            active: active.length,
            sold_or_deleted: sold.length,
            generating: (beats || []).filter((b) => b.status === "generating" && !b.sold).length,
          },
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ACTION: UPDATE-PRICE
    // ═══════════════════════════════════════════════════════════════════
    if (action === "update-price") {
      const { beat_id, price } = body;

      if (!beat_id) {
        return new Response(
          JSON.stringify({ error: "beat_id is required" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      if (price === null || price === undefined) {
        return new Response(
          JSON.stringify({ error: "price is required" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      const newPrice = parseFloat(price);
      if (isNaN(newPrice) || newPrice < 2.99) {
        return new Response(
          JSON.stringify({ error: "price must be at least $2.99" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Look up beat — must belong to this agent
      const { data: beat } = await supabase
        .from("beats")
        .select("id, title, price, sold, status, agent_id")
        .eq("id", beat_id)
        .eq("agent_id", agent.id)
        .single();

      if (!beat) {
        return new Response(
          JSON.stringify({ error: "Beat not found or does not belong to you" }),
          { status: 404, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      if (beat.sold) {
        return new Response(
          JSON.stringify({ error: "Cannot update price on a sold beat" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      if (beat.status !== "complete") {
        return new Response(
          JSON.stringify({ error: "Cannot update price — beat is still generating" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      const roundedPrice = Math.round(newPrice * 100) / 100;
      const oldPrice = beat.price;

      const { error: updateErr } = await supabase
        .from("beats")
        .update({ price: roundedPrice })
        .eq("id", beat.id);

      if (updateErr) throw updateErr;

      return new Response(
        JSON.stringify({
          success: true,
          beat: {
            id: beat.id,
            title: beat.title,
            old_price: oldPrice,
            new_price: roundedPrice,
          },
          message: `Price updated: "${beat.title}" is now $${roundedPrice.toFixed(2)}`,
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ACTION: DELETE
    // ═══════════════════════════════════════════════════════════════════
    if (action === "delete") {
      const { beat_id } = body;

      if (!beat_id) {
        return new Response(
          JSON.stringify({ error: "beat_id is required" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Look up beat — must belong to this agent
      const { data: beat } = await supabase
        .from("beats")
        .select("id, title, sold, agent_id")
        .eq("id", beat_id)
        .eq("agent_id", agent.id)
        .single();

      if (!beat) {
        return new Response(
          JSON.stringify({ error: "Beat not found or does not belong to you" }),
          { status: 404, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      if (beat.sold) {
        return new Response(
          JSON.stringify({ error: "Cannot delete a sold beat" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Soft-delete: set sold = true (beats_feed view filters WHERE sold IS NOT TRUE)
      const { error: deleteErr } = await supabase
        .from("beats")
        .update({ sold: true })
        .eq("id", beat.id);

      if (deleteErr) throw deleteErr;

      // Decrement beats_count on the agent
      const newCount = Math.max(0, (agent.beats_count || 0) - 1);
      await supabase
        .from("agents")
        .update({ beats_count: newCount })
        .eq("id", agent.id);

      return new Response(
        JSON.stringify({
          success: true,
          beat: { id: beat.id, title: beat.title },
          message: `"${beat.title}" has been removed from the catalog.`,
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }
  } catch (err) {
    const cors = getCorsHeaders(req);
    console.error("Manage beats error:", err.message);
    return new Response(
      JSON.stringify({ error: "Failed to manage beats. Please try again." }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
