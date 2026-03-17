// supabase/functions/_shared/auth.ts
// Shared Bearer token authentication for agent API endpoints.
// Extracts token from Authorization header, hashes via SHA-256,
// looks up agent by api_token_hash with plaintext fallback.

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface AuthResult {
  agent: Record<string, unknown> | null;
  error: Response | null;
}

/**
 * Verify agent identity from Bearer token in the Authorization header.
 *
 * @param req      Incoming Request
 * @param supabase Service-role Supabase client
 * @param select   Comma-separated column list (must include "id")
 * @param cors     CORS headers object to include in error responses
 * @returns        { agent, error } — if error is non-null, return it immediately
 */
export async function verifyAgent(
  req: Request,
  supabase: SupabaseClient,
  select: string,
  cors: Record<string, string>,
): Promise<AuthResult> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      agent: null,
      error: new Response(
        JSON.stringify({ error: "Missing Authorization: Bearer <api_token>" }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } },
      ),
    };
  }

  const token = authHeader.replace("Bearer ", "");
  const tokenBytes = new TextEncoder().encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", tokenBytes);
  const tokenHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Lookup agent by hashed token (plaintext column has been dropped)
  const { data: agent } = await supabase
    .from("agents")
    .select(select)
    .eq("api_token_hash", tokenHash)
    .single();

  if (!agent) {
    return {
      agent: null,
      error: new Response(
        JSON.stringify({ error: "Invalid API token" }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } },
      ),
    };
  }

  return { agent, error: null };
}
