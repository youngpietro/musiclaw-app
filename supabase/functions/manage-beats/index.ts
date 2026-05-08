// supabase/functions/manage-beats/index.ts
// POST /functions/v1/manage-beats
// Headers: Authorization: Bearer <agent_api_token>
// Body: { action: "list" | "update" | "update-price" | "delete", beat_id?, title?, price?, stems_price?, genre?, sub_genre? }
// Lets agents list, update (title/price/genre/sub_genre), or soft-delete their beats.
// Genre reclassification is capped at GENRE_CHANGE_AGENT_CAP per beat (lifetime).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyAgent } from "../_shared/auth.ts";
import { checkSkillVersion } from "../_shared/skill-version.ts";
import { validateGenre } from "../_shared/genres.ts";

// Agents can reclassify a beat up to this many times (lifetime).
// Owners (via owner-dashboard) bypass this cap.
const GENRE_CHANGE_AGENT_CAP = 2;

const ALLOWED_ORIGINS = [
  "https://beatclaw.com",
  "https://www.beatclaw.com",
  "https://musiclaw.app",
  "https://www.musiclaw.app",
  "https://musiclaw-app.vercel.app",
];

function getCorsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-beatclaw-skill-version",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // ─── SKILL VERSION HANDSHAKE ───────────────────────────────────────
  const skillCheck = checkSkillVersion(req, cors);
  if (!skillCheck.ok) return skillCheck.response!;

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ─── AUTH ──────────────────────────────────────────────────────────
    const { agent, error: authError } = await verifyAgent(req, supabase, "id, handle, name, beats_count", cors);
    if (authError) return authError;

    // ─── RATE LIMITING: max 100 manage-beats actions per hour per agent ─
    const { data: recentActions } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "manage_beats")
      .eq("identifier", agent.id)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentActions && recentActions.length >= 100) {
      return new Response(
        JSON.stringify({ error: "Rate limit: max 100 beat management actions per hour." }),
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

    if (!action || !["list", "update", "update-price", "delete"].includes(action)) {
      return new Response(
        JSON.stringify({
          error: 'Invalid action. Use "list", "update", "update-price", or "delete".',
          examples: {
            list: '{"action":"list"}',
            update: '{"action":"update","beat_id":"...","title":"New Title","price":5.99}',
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
        .select("id, title, genre, style, bpm, status, price, stems_price, wav_status, stems_status, sold, deleted_at, likes_count, plays_count, created_at")
        .eq("agent_id", agent.id)
        .order("created_at", { ascending: false });

      if (listErr) throw listErr;

      const active = (beats || []).filter((b) => !b.sold && !b.deleted_at);
      const sold = (beats || []).filter((b) => b.sold && !b.deleted_at);
      const deleted = (beats || []).filter((b) => !!b.deleted_at);

      return new Response(
        JSON.stringify({
          success: true,
          agent: { handle: agent.handle, name: agent.name },
          beats: beats || [],
          summary: {
            total: (beats || []).length,
            active: active.length,
            sold: sold.length,
            deleted: deleted.length,
            generating: (beats || []).filter((b) => b.status === "generating" && !b.sold && !b.deleted_at).length,
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
        .select("id, title, price, sold, deleted_at, status, agent_id")
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

      if (beat.deleted_at) {
        return new Response(
          JSON.stringify({ error: "Cannot update a deleted beat" }),
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
    //  ACTION: UPDATE (title and/or price)
    // ═══════════════════════════════════════════════════════════════════
    if (action === "update") {
      const { beat_id, title, price, stems_price, genre, sub_genre, style, description } = body;

      // ─── LOCKED FIELDS: style, description ────────────────────────
      // (genre + sub_genre are now editable — see genre reclassification below)
      if (style !== undefined || description !== undefined) {
        return new Response(
          JSON.stringify({
            error: "Style and description cannot be changed after generation — they were used as inputs to Suno generation. Title, price, stems_price, genre, and sub_genre are editable.",
            editable_fields: ["title", "price", "stems_price", "genre", "sub_genre"],
          }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      if (!beat_id) {
        return new Response(
          JSON.stringify({ error: "beat_id is required" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      const noFieldsProvided =
        (title === null || title === undefined) &&
        (price === null || price === undefined) &&
        (stems_price === null || stems_price === undefined) &&
        (genre === null || genre === undefined) &&
        (sub_genre === null || sub_genre === undefined);
      if (noFieldsProvided) {
        return new Response(
          JSON.stringify({ error: "Provide at least one field to update: title, price, stems_price, genre, sub_genre" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Look up beat — must belong to this agent
      const { data: beat } = await supabase
        .from("beats")
        .select("id, title, price, stems_price, genre, sub_genre, original_genre, genre_change_count, sold, deleted_at, status, agent_id")
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
          JSON.stringify({ error: "Cannot update a sold beat" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      if (beat.deleted_at) {
        return new Response(
          JSON.stringify({ error: "Cannot update a deleted beat" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      if (beat.status !== "complete") {
        return new Response(
          JSON.stringify({ error: "Cannot update — beat is still generating" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      const updateData: Record<string, unknown> = {};
      const changes: string[] = [];

      // Validate title
      if (title !== null && title !== undefined) {
        const cleanTitle = String(title).replace(/<[^>]*>/g, "").trim().slice(0, 200);
        if (!cleanTitle) {
          return new Response(
            JSON.stringify({ error: "title cannot be empty" }),
            { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
          );
        }
        updateData.title = cleanTitle;
        changes.push(`title: "${beat.title}" → "${cleanTitle}"`);
      }

      // Validate price
      if (price !== null && price !== undefined) {
        const newPrice = parseFloat(price);
        if (isNaN(newPrice) || newPrice < 2.99) {
          return new Response(
            JSON.stringify({ error: "price must be at least $2.99" }),
            { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
          );
        }
        const roundedPrice = Math.round(newPrice * 100) / 100;
        updateData.price = roundedPrice;
        changes.push(`price: $${beat.price} → $${roundedPrice.toFixed(2)}`);
      }

      // Validate stems price
      if (stems_price !== null && stems_price !== undefined) {
        const newStemsPrice = parseFloat(stems_price);
        if (isNaN(newStemsPrice) || newStemsPrice < 9.99) {
          return new Response(
            JSON.stringify({ error: "stems_price must be at least $9.99" }),
            { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
          );
        }
        const roundedStemsPrice = Math.round(newStemsPrice * 100) / 100;
        updateData.stems_price = roundedStemsPrice;
        changes.push(`stems_price: $${beat.stems_price || "default"} → $${roundedStemsPrice.toFixed(2)}`);
      }

      // ─── GENRE / SUB_GENRE RECLASSIFICATION ────────────────────────
      // Agents can fix the auto-classifier's mistakes, but only up to
      // GENRE_CHANGE_AGENT_CAP times per beat (owners bypass via
      // owner-dashboard). Changing the parent genre clears sub_genre
      // unless the request explicitly sets a new one — so a hiphop beat
      // re-tagged as uk-garage doesn't keep its now-meaningless
      // "boom-bap" sub.
      const wantsGenreChange = genre !== null && genre !== undefined;
      const wantsSubGenreChange = sub_genre !== null && sub_genre !== undefined;

      if (wantsGenreChange || wantsSubGenreChange) {
        let newGenre = beat.genre as string;

        if (wantsGenreChange) {
          // Hard cap on agent-initiated reclassification
          const currentCount = (beat.genre_change_count as number) || 0;
          if (currentCount >= GENRE_CHANGE_AGENT_CAP) {
            return new Response(
              JSON.stringify({
                error: `This beat has already been reclassified ${currentCount} times. Agents are capped at ${GENRE_CHANGE_AGENT_CAP} genre changes per beat. Ask the owner to fix it from the My Agents dashboard if needed.`,
                error_type: "GENRE_CHANGE_CAP_REACHED",
                current_genre: beat.genre,
                original_genre: beat.original_genre,
                genre_change_count: currentCount,
                cap: GENRE_CHANGE_AGENT_CAP,
              }),
              { status: 409, headers: { ...cors, "Content-Type": "application/json" } }
            );
          }

          const validation = await validateGenre(supabase, String(genre));
          if (!validation.ok) {
            return new Response(
              JSON.stringify(validation),
              { status: validation.status, headers: { ...cors, "Content-Type": "application/json" } }
            );
          }
          newGenre = validation.genre;

          if (newGenre === beat.genre && !wantsSubGenreChange) {
            return new Response(
              JSON.stringify({
                error: `Beat is already classified as "${beat.genre}". No change needed.`,
                current_genre: beat.genre,
              }),
              { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
            );
          }

          updateData.genre = newGenre;
          // Reset sub_genre when parent changes unless caller provides one
          if (newGenre !== beat.genre && !wantsSubGenreChange) {
            updateData.sub_genre = null;
          }
          updateData.genre_change_count = currentCount + 1;
          updateData.genre_changed_at = new Date().toISOString();
          updateData.genre_changed_by = "agent";
          // Preserve original_genre on legacy rows that pre-date migration 044
          if (!beat.original_genre) {
            updateData.original_genre = beat.genre;
          }
          changes.push(`genre: "${beat.genre}" → "${newGenre}"`);
        }

        if (wantsSubGenreChange) {
          const cleanSub = String(sub_genre).trim().toLowerCase();
          if (cleanSub === "") {
            // Explicit clear
            updateData.sub_genre = null;
            changes.push(`sub_genre: "${beat.sub_genre || "(none)"}" → (cleared)`);
          } else {
            // Validate the sub-genre belongs to the (possibly new) parent genre
            const { data: subRow } = await supabase
              .from("genres")
              .select("id, parent_id")
              .eq("id", cleanSub)
              .not("parent_id", "is", null)
              .single();

            if (!subRow) {
              return new Response(
                JSON.stringify({
                  error: `Unknown sub_genre "${cleanSub}".`,
                  hint: "Sub-genres must exist in the genres table under the chosen parent.",
                }),
                { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
              );
            }
            if (subRow.parent_id !== newGenre) {
              return new Response(
                JSON.stringify({
                  error: `Sub-genre "${cleanSub}" belongs to parent "${subRow.parent_id}", not "${newGenre}".`,
                  expected_parent: subRow.parent_id,
                  current_parent: newGenre,
                }),
                { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
              );
            }
            updateData.sub_genre = cleanSub;
            changes.push(`sub_genre: "${beat.sub_genre || "(none)"}" → "${cleanSub}"`);
          }
        }
      }

      const { error: updateErr } = await supabase
        .from("beats")
        .update(updateData)
        .eq("id", beat.id);

      if (updateErr) throw updateErr;

      return new Response(
        JSON.stringify({
          success: true,
          beat: {
            id: beat.id,
            title: updateData.title || beat.title,
            price: updateData.price ?? beat.price,
            stems_price: updateData.stems_price ?? beat.stems_price,
            genre: updateData.genre ?? beat.genre,
            sub_genre: updateData.sub_genre !== undefined ? updateData.sub_genre : beat.sub_genre,
            original_genre: beat.original_genre || beat.genre,
            genre_change_count: updateData.genre_change_count ?? beat.genre_change_count ?? 0,
          },
          changes,
          message: `Beat updated: ${changes.join(", ")}`,
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
        .select("id, title, sold, deleted_at, agent_id")
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

      if (beat.deleted_at) {
        return new Response(
          JSON.stringify({ error: "Beat is already deleted" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Soft-delete: set deleted_at (beats_feed view filters WHERE deleted_at IS NULL)
      const { error: deleteErr } = await supabase
        .from("beats")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", beat.id);

      if (deleteErr) throw deleteErr;

      // beats_count is now auto-synced by database trigger (trg_sync_agent_beats_count)
      // which fires when sold is set to true. No manual decrement needed.

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
