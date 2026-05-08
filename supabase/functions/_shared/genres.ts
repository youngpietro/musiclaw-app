// supabase/functions/_shared/genres.ts
// Shared genre normalization between generate-beat (auto-classifier)
// and manage-beats / owner-dashboard (post-hoc reclassification).
//
// We keep ONE alias map and ONE slug-normalizer in this module so
// agents can't end up in a state where a genre passes generate-beat
// validation but fails manage-beats validation (or vice versa).

export const GENRE_ALIASES: Record<string, string> = {
  // Core aliases
  "hip-hop": "hiphop", "hip hop": "hiphop", "rap": "hiphop",
  "r&b": "rnb", "r-b": "rnb", "randb": "rnb", "r-and-b": "rnb", "rhythm-and-blues": "rnb",
  "lo-fi": "lofi", "lo fi": "lofi",
  "uk-garage": "uk-garage", "ukgarage": "uk-garage", "uk garage": "uk-garage", "2-step": "uk-garage", "2step": "uk-garage",
  "drum-and-bass": "drum-and-bass", "drumandbass": "drum-and-bass", "dnb": "drum-and-bass", "drum and bass": "drum-and-bass", "jungle": "drum-and-bass",
  "triphop": "trip-hop", "trip hop": "trip-hop",
  "synthwave": "synthwave", "synth-wave": "synthwave", "retrowave": "synthwave", "outrun": "synthwave",
  "chillhop": "chillhop", "chill-hop": "chillhop", "chill hop": "chillhop",
  "afrobeat": "afrobeat", "afro-beat": "afrobeat", "afrobeats": "afrobeat",
  // Common alternate names
  "r and b": "rnb", "rhythm and blues": "rnb",
  "neosoul": "neo-soul", "neo soul": "neo-soul",
  "bossanova": "bossa-nova", "bossa nova": "bossa-nova",
  "postrock": "post-rock", "post rock": "post-rock",
  "newwave": "new-wave", "new wave": "new-wave",
  "psytrance": "psytrance", "psy-trance": "psytrance", "psy trance": "psytrance",
  "dance": "edm", "electronic dance music": "edm",
  "d&b": "drum-and-bass", "d and b": "drum-and-bass",
};

/**
 * Normalize a free-text genre input to a canonical slug.
 * Tolerates spaces, underscores, ampersands, mixed case.
 */
export function normalizeGenreSlug(raw: string): string {
  const lower = raw.trim().toLowerCase();
  // Check alias map first (before slug conversion)
  if (GENRE_ALIASES[lower]) return GENRE_ALIASES[lower];
  // Convert to slug: spaces/underscores → hyphens, strip special chars
  const slug = lower
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  // Check alias map again with the slug form
  if (GENRE_ALIASES[slug]) return GENRE_ALIASES[slug];
  return slug;
}

/**
 * Format a genre slug for display ("uk-garage" → "UK Garage").
 */
export function genreLabelFromSlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .replace(/\bRnb\b/, "R&B / Soul")
    .replace(/\bHiphop\b/, "Hip-Hop")
    .replace(/\bLofi\b/, "Lo-Fi")
    .replace(/\bUk\b/, "UK")
    .replace(/\bEdm\b/, "EDM")
    .replace(/\bDnb\b/, "D&B");
}

export interface SupabaseLike {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: unknown): {
        is(col: string, val: unknown): {
          single(): Promise<{ data: { id: string } | null }>;
        };
        not(col: string, op: string, val: unknown): {
          single(): Promise<{ data: { id: string; parent_id: string } | null }>;
        };
        single?: () => Promise<{ data: { id: string } | null }>;
      };
      is(col: string, val: unknown): {
        order(col: string): Promise<{ data: { id: string; label: string }[] | null }>;
      };
    };
  };
}

export type GenreValidationResult =
  | { ok: true; genre: string }
  | { ok: false; status: 400; error: string; valid_genres?: string[]; correct_genre?: string; sub_genre?: string };

/**
 * Validate a genre slug against the live `genres` table.
 * Returns `{ok: true, genre}` for a valid parent genre, or a structured
 * error describing what to do (sub-genre confusion, unknown value, etc.).
 *
 * `supabase` should be a service-role Supabase client. Using `any` here
 * because the typed client is overkill for one read query.
 */
// deno-lint-ignore no-explicit-any
export async function validateGenre(supabase: any, raw: string): Promise<GenreValidationResult> {
  const normalized = normalizeGenreSlug(raw);
  if (!normalized) {
    return { ok: false, status: 400, error: "Genre cannot be empty." };
  }

  const { data: validGenre } = await supabase
    .from("genres")
    .select("id")
    .eq("id", normalized)
    .is("parent_id", null)
    .single();

  if (validGenre) return { ok: true, genre: normalized };

  // Maybe the caller passed a sub-genre as the genre value
  const { data: asSub } = await supabase
    .from("genres")
    .select("id, parent_id")
    .eq("id", normalized)
    .not("parent_id", "is", null)
    .single();

  if (asSub) {
    return {
      ok: false,
      status: 400,
      error: `"${normalized}" is a sub-genre of "${asSub.parent_id}". Use genre: "${asSub.parent_id}" and optionally sub_genre: "${normalized}".`,
      correct_genre: asSub.parent_id,
      sub_genre: normalized,
    };
  }

  // Genre not found at all — return valid options
  const { data: allGenres } = await supabase
    .from("genres")
    .select("id, label")
    .is("parent_id", null)
    .order("label");

  return {
    ok: false,
    status: 400,
    error: `Unknown genre "${raw}" (normalized: "${normalized}"). Pick from the valid genre list.`,
    valid_genres: (allGenres || []).map((g: { id: string }) => g.id),
  };
}
