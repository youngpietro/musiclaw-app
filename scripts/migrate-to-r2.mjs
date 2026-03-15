#!/usr/bin/env node
// migrate-to-r2.mjs
// One-time batch migration: existing audio files → Cloudflare R2.
// For storage_migrated=true beats: downloads from Supabase Storage (signed URLs).
// For storage_migrated=false beats: downloads from Suno CDN (audio_url/stream_url).
//
// Run locally:
//   npm install @aws-sdk/client-s3   # one-time
//   node scripts/migrate-to-r2.mjs
//
// Requires: Node.js 18+ (for native fetch)

import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

// ─── CONFIG ────────────────────────────────────────────────────────────────
const SUPABASE_URL = "https://alxzlfutyhuyetqimlxi.supabase.co";
const SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFseHpsZnV0eWh1eWV0cWltbHhpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTM3MTY0MywiZXhwIjoyMDg2OTQ3NjQzfQ.o95kSscBAdJGAS62uK5PF-gxG-yMzCcJU89GNybXht0";
const BUCKET = "audio"; // Supabase Storage bucket name

// R2 config
const R2_ACCOUNT_ID = "23e10e6a946f28fce02bebc61d7749da";
const R2_ACCESS_KEY_ID = "df770f4458ec8cb5c38de4ce29e0e34b";
const R2_SECRET_ACCESS_KEY = "fa3c3954357662af1c854b7e1f552daca8b870b0940bb37556310473607262f7";
const R2_BUCKET_NAME = "musiclaw-audio";
const R2_PUBLIC_URL = "https://cdn.musiclaw.app";

const supaHeaders = {
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  apikey: SERVICE_ROLE_KEY,
};

// ─── R2 Client ─────────────────────────────────────────────────────────────
const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// ─── SUPABASE DB HELPERS (plain fetch, no SDK) ─────────────────────────────

async function dbQuery(table, { select = "*", filters = {}, order, limit } = {}) {
  const params = new URLSearchParams({ select });
  for (const [k, v] of Object.entries(filters)) params.append(k, v);
  if (order) params.append("order", order);
  if (limit) params.append("limit", String(limit));
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: { ...supaHeaders, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`DB query failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function dbUpdate(table, id, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...supaHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`DB update failed: ${res.status} ${await res.text()}`);
}

async function dbUpdateWhere(table, filters, data) {
  const params = new URLSearchParams(filters);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    method: "PATCH",
    headers: { ...supaHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`DB update failed: ${res.status} ${await res.text()}`);
}

// ─── SUPABASE STORAGE SIGNED URL ───────────────────────────────────────────

async function getSignedUrl(storagePath, expiresIn = 3600) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${storagePath}`, {
    method: "POST",
    headers: { ...supaHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.signedURL ? `${SUPABASE_URL}/storage/v1${data.signedURL}` : null;
}

// ─── R2 HELPERS ────────────────────────────────────────────────────────────

async function r2Upload(path, buffer, contentType) {
  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: path,
      Body: buffer,
      ContentType: contentType,
    })
  );
}

async function r2Exists(path) {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: path }));
    return true;
  } catch {
    return false;
  }
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

async function tryMigrateFile(sourceUrl, r2Path, label, skipIfExists = true) {
  if (!sourceUrl) return false;
  try {
    // Skip if already exists in R2
    if (skipIfExists && await r2Exists(r2Path)) {
      console.log(`    ⏭️  ${label} (already in R2)`);
      return true;
    }

    const { buffer, contentType } = await downloadFile(sourceUrl);
    await r2Upload(r2Path, buffer, contentType);
    console.log(`    ✅ ${label} → R2 (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
    return true;
  } catch (err) {
    console.error(`    ❌ ${label}: ${err.message}`);
    return false;
  }
}

// ─── MIGRATE BEATS ─────────────────────────────────────────────────────────

async function migrateBeats() {
  // Get ALL complete beats (both migrated and non-migrated)
  const beats = await dbQuery("beats", {
    select: "id,title,audio_url,stream_url,image_url,stems,status,storage_migrated,suno_id,created_at",
    filters: { status: "eq.complete" },
    order: "created_at.asc",
  });

  console.log(`\n🎵 Found ${beats.length} complete beats to check\n`);

  let success = 0, skipped = 0, failed = 0;

  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    const age = Math.round((Date.now() - new Date(beat.created_at).getTime()) / 86400000);
    console.log(`[${i + 1}/${beats.length}] "${beat.title}" (${age}d old, migrated=${beat.storage_migrated}) — ${beat.id}`);

    let audioOk = false;
    let imageOk = false;
    let stemsOk = true;

    // ─── Source URLs ─────────────────────────────────────────────────
    // For storage_migrated=true: try Supabase Storage signed URL first
    // For storage_migrated=false: use CDN URLs directly

    // 1. MP3 audio
    if (beat.storage_migrated) {
      // Already in Supabase Storage → get signed URL to download from there
      const signedUrl = await getSignedUrl(`beats/${beat.id}/track.mp3`);
      if (signedUrl) {
        audioOk = await tryMigrateFile(signedUrl, `beats/${beat.id}/track.mp3`, "MP3 audio (from Supabase Storage)");
      }
    }
    if (!audioOk) {
      // Try CDN URLs
      audioOk = await tryMigrateFile(beat.audio_url, `beats/${beat.id}/track.mp3`, "MP3 audio (from CDN)");
    }
    if (!audioOk && beat.stream_url && beat.stream_url !== beat.audio_url) {
      console.log("    ⏳ Trying stream_url as fallback...");
      audioOk = await tryMigrateFile(beat.stream_url, `beats/${beat.id}/track.mp3`, "MP3 audio (via stream_url)");
    }
    if (!audioOk && beat.suno_id) {
      console.log("    ⏳ Trying Suno CDN direct...");
      audioOk = await tryMigrateFile(
        `https://cdn1.suno.ai/${beat.suno_id}.mp3`,
        `beats/${beat.id}/track.mp3`,
        "MP3 audio (via Suno CDN direct)"
      );
    }

    // 2. Cover image
    if (beat.image_url) {
      if (beat.storage_migrated) {
        const signedUrl = await getSignedUrl(`beats/${beat.id}/cover.jpg`);
        if (signedUrl) {
          imageOk = await tryMigrateFile(signedUrl, `beats/${beat.id}/cover.jpg`, "Cover image (from Supabase Storage)");
        }
      }
      if (!imageOk) {
        imageOk = await tryMigrateFile(beat.image_url, `beats/${beat.id}/cover.jpg`, "Cover image (from CDN)");
      }
    }

    // 3. Stems (if any)
    if (beat.stems && typeof beat.stems === "object") {
      const stems = typeof beat.stems === "string" ? JSON.parse(beat.stems) : beat.stems;
      for (const [stemType, stemUrl] of Object.entries(stems)) {
        if (!stemUrl || stemType === "origin") continue;

        let stemOk = false;
        if (beat.storage_migrated) {
          const signedUrl = await getSignedUrl(`beats/${beat.id}/stems/${stemType}.mp3`);
          if (signedUrl) {
            stemOk = await tryMigrateFile(signedUrl, `beats/${beat.id}/stems/${stemType}.mp3`, `Stem: ${stemType} (from Supabase Storage)`);
          }
        }
        if (!stemOk) {
          stemOk = await tryMigrateFile(stemUrl, `beats/${beat.id}/stems/${stemType}.mp3`, `Stem: ${stemType} (from CDN)`);
        }
        if (!stemOk) stemsOk = false;
      }
    }

    // 4. Mark as migrated if audio succeeded
    if (audioOk) {
      if (!beat.storage_migrated) {
        await dbUpdate("beats", beat.id, { storage_migrated: true });
      }

      // Also mark related samples as migrated
      if (beat.stems && stemsOk) {
        await dbUpdateWhere("samples", { beat_id: `eq.${beat.id}` }, { storage_migrated: true });
      }

      success++;
      console.log(`    ✅ Beat in R2\n`);
    } else {
      failed++;
      console.log(`    ⚠️  Beat FAILED (audio unavailable)\n`);
    }
  }

  console.log(`\n📊 Beats migration: ${success} success, ${failed} failed out of ${beats.length}`);
  return { success, failed };
}

// ─── MIGRATE ORPHAN SAMPLES ────────────────────────────────────────────────

async function migrateOrphanSamples() {
  const samples = await dbQuery("samples", {
    select: "id,beat_id,stem_type,audio_url,storage_migrated",
    filters: { storage_migrated: "eq.false" },
  });

  if (!samples || samples.length === 0) {
    console.log("\n✅ No orphan samples to migrate");
    return;
  }

  console.log(`\n🎤 Found ${samples.length} orphan samples to check\n`);
  let fixed = 0;

  for (const sample of samples) {
    const r2Path = `beats/${sample.beat_id}/stems/${sample.stem_type}.mp3`;

    // Check if already exists in R2
    if (await r2Exists(r2Path)) {
      await dbUpdate("samples", sample.id, { storage_migrated: true });
      fixed++;
      continue;
    }

    // Try uploading from sample's own audio_url
    if (sample.audio_url) {
      const ok = await tryMigrateFile(sample.audio_url, r2Path, `Sample: ${sample.stem_type}`, false);
      if (ok) {
        await dbUpdate("samples", sample.id, { storage_migrated: true });
        fixed++;
      }
    }
  }

  console.log(`\n📊 Orphan samples: ${fixed} fixed out of ${samples.length}`);
}

// ─── MAIN ──────────────────────────────────────────────────────────────────

console.log("🚀 MusiClaw Audio Migration: Supabase Storage + CDN → Cloudflare R2");
console.log(`   R2 Bucket: ${R2_BUCKET_NAME}`);
console.log(`   R2 Public: ${R2_PUBLIC_URL}`);
console.log(`   Supabase:  ${SUPABASE_URL}`);
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
