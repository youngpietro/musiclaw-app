/**
 * cleanup-silent-samples.mjs
 *
 * Deletes silent samples (audio_amplitude <= 25) from both
 * Supabase Storage and the `samples` database table.
 *
 * Usage:  node scripts/cleanup-silent-samples.mjs
 */

const SUPABASE_URL = "https://alxzlfutyhuyetqimlxi.supabase.co";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFseHpsZnV0eWh1eWV0cWltbHhpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTM3MTY0MywiZXhwIjoyMDg2OTQ3NjQzfQ.o95kSscBAdJGAS62uK5PF-gxG-yMzCcJU89GNybXht0";

const headers = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};

// -- 1. Query all samples with audio_amplitude <= 25 --
async function fetchSilentSamples() {
  const url = `${SUPABASE_URL}/rest/v1/samples?audio_amplitude=lte.25&select=id,beat_id,stem_type,audio_amplitude`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch samples: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// -- 2. Delete a single file from Storage --
async function deleteStorageFile(beatId, stemType) {
  const path = `audio/beats/${beatId}/stems/${stemType}.mp3`;
  const url = `${SUPABASE_URL}/storage/v1/object/${path}`;

  const res = await fetch(url, { method: "DELETE", headers });
  // 200 = deleted, 404 = already gone -- both are acceptable
  if (res.ok || res.status === 404 || res.status === 400) {
    return { path, status: res.status, ok: true };
  }
  const body = await res.text();
  return { path, status: res.status, ok: false, error: body };
}

// -- 3. Batch-delete rows from the samples table --
async function deleteSampleRows() {
  const url = `${SUPABASE_URL}/rest/v1/samples?audio_amplitude=lte.25`;

  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      ...headers,
      Prefer: "return=representation",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to delete rows: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// -- Main --
async function main() {
  console.log("=== Cleanup Silent Samples (audio_amplitude <= 25) ===\n");

  // Step 1 -- fetch
  const samples = await fetchSilentSamples();
  console.log(`Found ${samples.length} silent sample(s) in the database.\n`);

  if (samples.length === 0) {
    console.log("Nothing to do -- exiting.");
    return;
  }

  // Step 2 -- delete storage files (concurrency-limited to 10 at a time)
  console.log("Deleting storage files...");
  let storageOk = 0;
  let storageFail = 0;
  let storageNotFound = 0;

  const CONCURRENCY = 10;
  for (let i = 0; i < samples.length; i += CONCURRENCY) {
    const batch = samples.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((s) => deleteStorageFile(s.beat_id, s.stem_type))
    );
    for (const r of results) {
      if (r.ok && (r.status === 404 || r.status === 400)) {
        storageNotFound++;
      } else if (r.ok) {
        storageOk++;
      } else {
        storageFail++;
        console.error(`  FAIL ${r.path} -- ${r.status}: ${r.error}`);
      }
    }
    // progress every 50
    if ((i + CONCURRENCY) % 50 < CONCURRENCY) {
      console.log(`  ... processed ${Math.min(i + CONCURRENCY, samples.length)} / ${samples.length}`);
    }
  }

  console.log(
    `\nStorage results: ${storageOk} deleted, ${storageNotFound} already gone, ${storageFail} failed.\n`
  );

  // Step 3 -- delete rows from DB
  console.log("Deleting rows from the samples table...");
  const deleted = await deleteSampleRows();
  console.log(`Deleted ${deleted.length} row(s) from the samples table.\n`);

  // Step 4 -- summary
  console.log("=== Summary ===");
  console.log(`  Samples queried:        ${samples.length}`);
  console.log(`  Storage files deleted:   ${storageOk}`);
  console.log(`  Storage already gone:    ${storageNotFound}`);
  console.log(`  Storage failures:        ${storageFail}`);
  console.log(`  DB rows deleted:         ${deleted.length}`);
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
