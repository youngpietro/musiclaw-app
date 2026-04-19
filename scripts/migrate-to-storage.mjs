#!/usr/bin/env node
// migrate-to-storage.mjs
// One-time batch migration: download audio/image files from Suno CDN → upload to Supabase Storage.
// Run locally:  node scripts/migrate-to-storage.mjs
// Requires: Node.js 18+ (for native fetch)
// No npm install needed — zero dependencies.
//
// File path convention in 'audio' bucket:
//   beats/{beat_id}/track.mp3
//   beats/{beat_id}/cover.jpg
//   beats/{beat_id}/stems/{stem_type}.mp3

// ─── CONFIG ────────────────────────────────────────────────────────────────
const SUPABASE_URL = "https://alxzlfutyhuyetqimlxi.supabase.co";
const SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFseHpsZnV0eWh1eWV0cWltbHhpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTM3MTY0MywiZXhwIjoyMDg2OTQ3NjQzfQ.o95kSscBAdJGAS62uK5PF-gxG-yMzCcJU89GNybXht0";
const BUCKET = "audio";

const headers = {
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  apikey: SERVICE_ROLE_KEY,
};

// ─── SUPABASE HELPERS (plain fetch, no SDK) ────────────────────────────────

async function dbQuery(table, { select = "*", filters = {}, order, limit } = {}) {
  const params = new URLSearchParams({ select });
  for (const [k, v] of Object.entries(filters)) params.append(k, v);
  if (order) params.append("order", order);
  if (limit) params.append("limit", String(limit));
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: { ...headers, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`DB query failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function dbUpdate(table, id, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`DB update failed: ${res.status} ${await res.text()}`);
}

async function dbUpdateWhere(table, filters, data) {
  const params = new URLSearchParams(filters);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`DB update failed: ${res.status} ${await res.text()}`);
}

async function storageUpload(path, buffer, contentType) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: buffer,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Storage upload failed for ${path}: ${res.status} ${text}`);
  }
}

async function storageList(prefix) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix, limit: 100 }),
  });
  if (!res.ok) return [];
  return res.json();
}

// ─── DOWNLOAD + UPLOAD HELPER ──────────────────────────────────────────────

async function downloadFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    buffer,
    contentType: res.headers.get("content-type") || "application/octet-stream",
  };
}

async function tryDownloadAndUpload(url, storagePath, label) {
  if (!url) return false;
  try {
    const { buffer, contentType } = await downloadFile(url);
    await storageUpload(storagePath, buffer, contentType);
    console.log(`    ✅ ${label} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
    return true;
  } catch (err) {
    console.error(`    ❌ ${label}: ${err.message}`);
    return false;
  }
}

// ─── MIGRATE BEATS ─────────────────────────────────────────────────────────

async function migrateBeats() {
  const beats = await dbQuery("beats", {
    select: "id,title,audio_url,stream_url,image_url,stems,status,created_at",
    filters: { storage_migrated: "eq.false", status: "eq.complete" },
    order: "created_at.asc", // oldest first (most urgent, closest to expiry)
  });

  console.log(`\n🎵 Found ${beats.length} beats to migrate\n`);

  let success = 0, failed = 0;

  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    const age = Math.round((Date.now() - new Date(beat.created_at).getTime()) / 86400000);
    console.log(`[${i + 1}/${beats.length}] "${beat.title}" (${age}d old) — ${beat.id}`);

    let audioOk = false;
    let imageOk = false;
    let stemsOk = true;

    // 1. MP3 audio (try audio_url first, then stream_url as fallback)
    audioOk = await tryDownloadAndUpload(
      beat.audio_url,
      `beats/${beat.id}/track.mp3`,
      "MP3 audio"
    );
    if (!audioOk && beat.stream_url && beat.stream_url !== beat.audio_url) {
      console.log("    ⏳ Trying stream_url as fallback...");
      audioOk = await tryDownloadAndUpload(
        beat.stream_url,
        `beats/${beat.id}/track.mp3`,
        "MP3 audio (via stream_url)"
      );
    }

    // 2. Cover image
    if (beat.image_url) {
      imageOk = await tryDownloadAndUpload(
        beat.image_url,
        `beats/${beat.id}/cover.jpg`,
        "Cover image"
      );
    }

    // 3. Stems (if any)
    if (beat.stems && typeof beat.stems === "object") {
      const stems = typeof beat.stems === "string" ? JSON.parse(beat.stems) : beat.stems;
      for (const [stemType, stemUrl] of Object.entries(stems)) {
        if (!stemUrl || stemType === "origin") continue;
        const stemOk = await tryDownloadAndUpload(
          stemUrl,
          `beats/${beat.id}/stems/${stemType}.mp3`,
          `Stem: ${stemType}`
        );
        if (!stemOk) stemsOk = false;
      }
    }

    // 4. Mark as migrated if audio succeeded
    if (audioOk) {
      await dbUpdate("beats", beat.id, { storage_migrated: true });

      // Also mark related samples as migrated
      if (beat.stems && stemsOk) {
        await dbUpdateWhere("samples", { beat_id: `eq.${beat.id}` }, { storage_migrated: true });
      }

      success++;
      console.log(`    ✅ Beat migrated successfully\n`);
    } else {
      failed++;
      console.log(`    ⚠️  Beat FAILED (audio unavailable — URL may be expired)\n`);
    }
  }

  console.log(`\n📊 Beats migration: ${success} success, ${failed} failed out of ${beats.length}`);
  return { success, failed };
}

// ─── MIGRATE ORPHAN SAMPLES ────────────────────────────────────────────────

async function migrateOrphanSamples() {
  const samples = await dbQuery("samples", {
    select: "id,beat_id,stem_type,audio_url",
    filters: { storage_migrated: "eq.false" },
  });

  if (!samples || samples.length === 0) {
    console.log("\n✅ No orphan samples to migrate");
    return;
  }

  console.log(`\n🎤 Found ${samples.length} orphan samples to check\n`);
  let fixed = 0;

  for (const sample of samples) {
    // Check if the stem file already exists in storage (uploaded during beat migration)
    const files = await storageList(`beats/${sample.beat_id}/stems`);
    const exists = files?.some(f => f.name === `${sample.stem_type}.mp3`);

    if (exists) {
      await dbUpdate("samples", sample.id, { storage_migrated: true });
      fixed++;
    } else if (sample.audio_url) {
      // Try uploading from sample's own audio_url
      const ok = await tryDownloadAndUpload(
        sample.audio_url,
        `beats/${sample.beat_id}/stems/${sample.stem_type}.mp3`,
        `Sample: ${sample.stem_type}`
      );
      if (ok) {
        await dbUpdate("samples", sample.id, { storage_migrated: true });
        fixed++;
      }
    }
  }

  console.log(`\n📊 Orphan samples: ${fixed} fixed out of ${samples.length}`);
}

// ─── MAIN ──────────────────────────────────────────────────────────────────

console.log("🚀 BeatClaw Audio Migration: Suno CDN → Supabase Storage");
console.log(`   Bucket: ${BUCKET}`);
console.log(`   Project: ${SUPABASE_URL}`);
console.log(`   Time: ${new Date().toISOString()}\n`);

const beatResult = await migrateBeats();
await migrateOrphanSamples();

// Final status
const remainingBeats = await dbQuery("beats", {
  select: "id",
  filters: { storage_migrated: "eq.false", status: "eq.complete" },
});
const remainingSamples = await dbQuery("samples", {
  select: "id",
  filters: { storage_migrated: "eq.false" },
});

console.log(`\n📋 Remaining un-migrated: ${remainingBeats.length} beats, ${remainingSamples.length} samples`);
console.log("🏁 Done!");
