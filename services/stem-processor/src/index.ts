import express from "express";
import { createSeparation, pollForCompletion } from "./mvsep";
import { processAndStoreStems, getSupabaseClient } from "./storage";
import type { ProcessStemsRequest } from "./types";

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || "3000", 10);
const SERVICE_SECRET = process.env.RAILWAY_SERVICE_SECRET;

// Track in-progress jobs to prevent duplicates
const activeJobs = new Set<string>();

// ─── Health check ───────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", activeJobs: activeJobs.size });
});

// ─── Main endpoint ──────────────────────────────────────────────────────
app.post("/process-stems", (req, res) => {
  // 1. Validate shared secret
  const secret = req.headers["x-service-secret"];
  if (!SERVICE_SECRET || secret !== SERVICE_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // 2. Validate request body
  const { beat_id, agent_id, mvsep_api_key, audio_url, suno_id } =
    req.body as ProcessStemsRequest;

  if (!beat_id || !agent_id || !mvsep_api_key || !audio_url) {
    res
      .status(400)
      .json({ error: "Missing required fields: beat_id, agent_id, mvsep_api_key, audio_url" });
    return;
  }

  // 3. Prevent duplicate processing
  if (activeJobs.has(beat_id)) {
    res.status(409).json({ error: "Beat is already being processed", beat_id });
    return;
  }

  // 4. Respond immediately (fire-and-forget)
  res.status(202).json({
    accepted: true,
    beat_id,
    message: "Stem processing started. Beat status will update automatically.",
  });

  // 5. Process asynchronously
  processBeats({ beat_id, agent_id, mvsep_api_key, audio_url, suno_id }).catch(
    (err) => {
      console.error(`Unhandled error processing beat ${beat_id}:`, err);
    }
  );
});

// ─── Async processing pipeline ─────────────────────────────────────────
async function processBeats(params: ProcessStemsRequest): Promise<void> {
  const { beat_id, mvsep_api_key, audio_url } = params;
  activeJobs.add(beat_id);

  const supabase = getSupabaseClient();

  try {
    // Mark as processing
    await supabase
      .from("beats")
      .update({ stems_status: "processing" })
      .eq("id", beat_id);

    console.log(`[${beat_id}] Starting MVSEP separation...`);

    // 1. Create MVSEP job
    const hash = await createSeparation(mvsep_api_key, audio_url);
    console.log(`[${beat_id}] MVSEP job created: hash=${hash}`);

    // 2. Poll for completion (blocks up to 10 minutes)
    const stemFiles = await pollForCompletion(hash);
    console.log(
      `[${beat_id}] MVSEP complete: ${stemFiles.length} stems (${stemFiles.map((f) => f.name).join(", ")})`
    );

    if (stemFiles.length === 0) {
      throw new Error("MVSEP returned no stem files");
    }

    // 3. Download, detect silence, upload, create samples
    const result = await processAndStoreStems(supabase, beat_id, stemFiles);
    console.log(
      `[${beat_id}] Done: ${result.samplesCreated} samples created, ${result.samplesSkipped} skipped`
    );

    // 4. Update beat with stem URLs and mark complete
    await supabase
      .from("beats")
      .update({
        stems: result.storedStems,
        stems_status: "complete",
      })
      .eq("id", beat_id);

    console.log(
      `[${beat_id}] Stems complete: ${Object.keys(result.storedStems).join(", ")}`
    );
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[${beat_id}] Stem processing failed:`, message);

    await supabase
      .from("beats")
      .update({ stems_status: "failed", stems: null })
      .eq("id", beat_id);
  } finally {
    activeJobs.delete(beat_id);
  }
}

// ─── Graceful shutdown ──────────────────────────────────────────────────
function shutdown(signal: string) {
  console.log(
    `${signal} received. Active jobs: ${activeJobs.size}. Waiting for completion...`
  );
  // Give active jobs up to 30s to finish
  const timeout = setTimeout(() => {
    console.log("Shutdown timeout — exiting");
    process.exit(0);
  }, 30_000);

  const check = setInterval(() => {
    if (activeJobs.size === 0) {
      clearInterval(check);
      clearTimeout(timeout);
      console.log("All jobs complete — exiting");
      process.exit(0);
    }
  }, 1000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Start server ───────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`stem-processor listening on port ${PORT}`);
});
