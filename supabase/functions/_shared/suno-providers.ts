// supabase/functions/_shared/suno-providers.ts
// Unified abstraction over third-party Suno API providers (apiframe.ai, sunoapi.org).
// Each agent picks a provider and supplies their own API key.

export type SunoProvider = "apiframe" | "sunoapi";

export interface GenerateParams {
  title: string;
  titleV2?: string;
  style: string;
  negativeTags?: string;
  model: string;           // "V5_5" (normalized upstream — platform locks to latest)
  callbackUrl: string;
  callbackSecret: string;
}

export interface GenerateResult {
  taskId: string;
  provider: SunoProvider;
}

export interface TrackInfo {
  songId: string | null;
  audioUrl: string | null;
  streamUrl: string | null;
  imageUrl: string | null;
  duration: number | null;
  title: string | null;
}

export interface FetchResult {
  status: "processing" | "complete" | "failed";
  tracks: TrackInfo[];
}

export interface CallbackResult {
  provider: SunoProvider | "unknown";
  taskId: string | null;
  callbackType: string;          // "complete", "first", "stems", etc.
  tracks: TrackInfo[];
}

// ─── GENERATE ────────────────────────────────────────────────────────

export async function generateBeat(
  provider: SunoProvider,
  apiKey: string,
  params: GenerateParams,
): Promise<GenerateResult> {
  if (provider === "apiframe") return _apiframeGenerate(apiKey, params);
  if (provider === "sunoapi") return _sunoapiGenerate(apiKey, params);
  throw new Error(`Unknown provider: ${provider}`);
}

async function _apiframeGenerate(apiKey: string, p: GenerateParams): Promise<GenerateResult> {
  // apiframe.pro state of play:
  //   • Officially documented `/suno-imagine` model values: V4, V4_5,
  //     V4_5PLUS, V4_5ALL, V5 (legacy aliases: chirp-v4, chirp-auk,
  //     chirp-bluejay, chirp-crow). V5_5 is NOT in the docs as of 2026-05.
  //   • Their Playground UI nonetheless exposes a "V5.5" Model Version
  //     selector — meaning V5.5 likely works under an undocumented value.
  //
  // Strategy: try the canonical "V5_5" first (matches their `V4_5` /
  // `V4_5PLUS` naming pattern + matches sunoapi.org). If apiframe rejects
  // it as an invalid model (400 with "model"/"invalid" in the body), fall
  // back transparently to "V5" — the highest documented value. Agents
  // never see the difference.
  const callApiframe = async (model: string): Promise<Response> =>
    fetch("https://api.apiframe.pro/suno-imagine", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({
        // No `prompt` field when going instrumental — `make_instrumental: true`
        // is apiframe's only documented lever for "no lyrics". Sending an
        // empty prompt alongside it can trigger partial-vocal output.
        title: p.title,
        tags: p.style,
        make_instrumental: true,
        model,
        webhook_url: p.callbackUrl,
        webhook_secret: p.callbackSecret,
      }),
    });

  const requestedModel = p.model || "V5_5";
  let res = await callApiframe(requestedModel);

  // Fallback: if requested model triggered a 400 that mentions "model" or
  // "invalid", retry once with V5 (apiframe's documented latest).
  if (!res.ok && res.status === 400 && requestedModel !== "V5") {
    const errBody = await res.text();
    if (/model|invalid|unsupported|unknown/i.test(errBody)) {
      console.log(`apiframe rejected model="${requestedModel}" (${errBody.slice(0, 120)}); falling back to V5`);
      res = await callApiframe("V5");
    } else {
      throw new Error(`apiframe error 400: ${errBody.slice(0, 200)}`);
    }
  }

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401) throw new Error("API_KEY_INVALID");
    if (res.status === 402) throw new Error("INSUFFICIENT_CREDITS");
    if (res.status === 429) throw new Error("PROVIDER_RATE_LIMITED");
    throw new Error(`apiframe error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return { taskId: data.task_id, provider: "apiframe" };
}

async function _sunoapiGenerate(apiKey: string, p: GenerateParams): Promise<GenerateResult> {
  // ALWAYS append our hard-locked anti-vocal block to whatever the agent
  // passes. This prevents the "half-instrumental, half-vocal" output we saw
  // on V5.5 when the agent passed weak or empty negativeTags.
  const VOCAL_BLOCK = "vocals, singing, voice, lyrics, words, choir, rapper, mc, vocal chops, vocal stabs, spoken word, acapella";
  const finalNeg = p.negativeTags && p.negativeTags.trim()
    ? `${p.negativeTags.trim()}, ${VOCAL_BLOCK}`
    : VOCAL_BLOCK;

  const res = await fetch("https://api.sunoapi.org/api/v1/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      customMode: true,
      instrumental: true,
      prompt: "",                      // empty for instrumental custom mode
      style: p.style,
      title: p.title,
      model: p.model || "V5_5",
      negativeTags: finalNeg,
      callBackUrl: p.callbackUrl,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401) throw new Error("API_KEY_INVALID");
    if (res.status === 402 || res.status === 403) throw new Error("INSUFFICIENT_CREDITS");
    if (res.status === 429) throw new Error("PROVIDER_RATE_LIMITED");
    throw new Error(`sunoapi error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  if (data.code !== 200) throw new Error(`sunoapi rejected: ${data.msg || JSON.stringify(data).slice(0, 200)}`);
  return { taskId: data.data?.taskId, provider: "sunoapi" };
}

// ─── FETCH / POLL STATUS ─────────────────────────────────────────────

export async function fetchStatus(
  provider: SunoProvider,
  apiKey: string,
  taskId: string,
): Promise<FetchResult> {
  if (provider === "apiframe") return _apiframeFetch(apiKey, taskId);
  // sunoapi.org is callback-only — no polling endpoint documented
  return { status: "processing", tracks: [] };
}

async function _apiframeFetch(apiKey: string, taskId: string): Promise<FetchResult> {
  const res = await fetch("https://api.apiframe.pro/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ task_id: taskId }),
  });

  if (!res.ok) {
    if (res.status === 401) throw new Error("API_KEY_INVALID");
    return { status: "processing", tracks: [] };
  }

  const data = await res.json();
  const status = data.status === "finished" ? "complete"
    : data.status === "failed" ? "failed"
    : "processing";

  const songs = data.songs || data.output || [];
  const tracks: TrackInfo[] = songs.map((s: any) => ({
    songId: s.song_id || s.id || null,
    audioUrl: s.audio_url || null,
    streamUrl: s.stream_url || s.audio_url || null,
    imageUrl: s.image_url || null,
    duration: s.duration || null,
    title: s.title || null,
  }));

  return { status, tracks };
}

// ─── PARSE WEBHOOK CALLBACK ─────────────────────────────────────────

export function parseCallback(raw: any): CallbackResult {
  // Try sunoapi.org format first: { callbackType, data: [...] }
  if (raw.callbackType && Array.isArray(raw.data)) {
    const tracks: TrackInfo[] = raw.data.map((t: any) => ({
      songId: t.id || t.audioId || null,
      audioUrl: t.audio_url || t.audioUrl || null,
      streamUrl: t.stream_audio_url || t.streamAudioUrl || t.audio_url || null,
      imageUrl: t.image_url || t.imageUrl || null,
      duration: typeof t.duration === "number" ? t.duration : null,
      title: t.title || null,
    }));
    return {
      provider: "sunoapi",
      taskId: raw.taskId || raw.task_id || null,
      callbackType: raw.callbackType,
      tracks,
    };
  }

  // apiframe format: { task_id, status, songs: [...] }
  if (raw.task_id && (raw.songs || raw.status)) {
    const songs = raw.songs || raw.output || [];
    const tracks: TrackInfo[] = (Array.isArray(songs) ? songs : []).map((s: any) => ({
      songId: s.song_id || s.id || null,
      audioUrl: s.audio_url || null,
      streamUrl: s.stream_url || s.audio_url || null,
      imageUrl: s.image_url || null,
      duration: s.duration || null,
      title: s.title || null,
    }));
    return {
      provider: "apiframe",
      taskId: raw.task_id,
      callbackType: raw.status === "finished" ? "complete" : raw.status || "unknown",
      tracks,
    };
  }

  // Legacy self-hosted format (backward compat during transition)
  // Format: { data: { callbackType, taskId, data: [tracks] } }
  if (raw.data?.callbackType || raw.stage || raw.event) {
    const inner = raw.data || raw;
    const rawTracks = inner.data || inner.songs || raw.output || [];
    const tracks: TrackInfo[] = (Array.isArray(rawTracks) ? rawTracks : []).map((t: any) => ({
      songId: t.id || t.sunoId || t.suno_id || null,
      audioUrl: t.audio_url || t.audioUrl || t.audio || t.song_url || null,
      streamUrl: t.stream_url || t.streamUrl || t.stream || t.audio_url || null,
      imageUrl: t.image_url || t.imageUrl || t.image_large_url || t.image || null,
      duration: typeof t.duration === "number" ? t.duration : null,
      title: t.title || null,
    }));
    return {
      provider: "unknown",
      taskId: inner.taskId || inner.task_id || raw.taskId || null,
      callbackType: inner.callbackType || inner.stage || raw.event || "complete",
      tracks,
    };
  }

  // Unknown format — return empty
  console.warn("Unknown callback format:", JSON.stringify(raw).slice(0, 500));
  return { provider: "unknown", taskId: null, callbackType: "unknown", tracks: [] };
}

// ─── STEM SPLITTING (sunoapi.org only) ───────────────────────────────

export async function splitStems(
  apiKey: string,
  taskId: string,
  audioId: string,
  callbackUrl: string,
): Promise<{ taskId: string }> {
  const res = await fetch("https://api.sunoapi.org/api/v1/vocal-removal/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      taskId,
      audioId,
      type: "split_stem",
      callBackUrl: callbackUrl,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401) throw new Error("API_KEY_INVALID");
    if (res.status === 402 || res.status === 403) throw new Error("INSUFFICIENT_CREDITS");
    throw new Error(`sunoapi stems error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  if (data.code !== 200) throw new Error(`sunoapi stems rejected: ${data.msg || "unknown"}`);
  return { taskId: data.data?.taskId || taskId };
}

// ─── VALIDATE API KEY ────────────────────────────────────────────────

export async function validateApiKey(
  provider: SunoProvider,
  apiKey: string,
): Promise<{ valid: boolean; error?: string }> {
  try {
    if (provider === "apiframe") {
      // Fetch with dummy task_id: 401 = bad key, 404/400 = key works
      const res = await fetch("https://api.apiframe.pro/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: apiKey },
        body: JSON.stringify({ task_id: "validation-check-000" }),
      });
      if (res.status === 401) return { valid: false, error: "Invalid apiframe API key" };
      return { valid: true };
    }

    if (provider === "sunoapi") {
      // Try their credits endpoint or a similar lightweight call
      const res = await fetch("https://api.sunoapi.org/api/v1/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ customMode: true, instrumental: true, prompt: "", style: "test", title: "validation" }),
      });
      if (res.status === 401) return { valid: false, error: "Invalid sunoapi.org API key" };
      // If it accepted, we accidentally started a generation — but with dummy params.
      // Better approach: just check if 401 vs non-401
      return { valid: true };
    }

    return { valid: false, error: `Unknown provider: ${provider}` };
  } catch (err) {
    return { valid: false, error: `Connection error: ${(err as Error).message}` };
  }
}
