// Stem types that should NOT become purchasable samples.
// "instrumental" / "instrum" = full beat minus vocals (would undercut beat sales)
// "vocals" / "vocal" / "backing_vocals" / "lead_vocals" = empty on instrumental beats
export const EXCLUDED_SAMPLE_TYPES = new Set([
  "instrumental",
  "instrum",
  "vocals",
  "vocal",
  "backing_vocals",
  "lead_vocals",
]);

// Silence detection: anything below this mean volume (dB) is considered silent.
// Real stems: -15 to -25 dB. Silent stems: -91 dB. Threshold safely in the middle.
export const SILENCE_THRESHOLD_DB = -70;

// MVSEP API configuration
export const MVSEP_SEP_TYPE = "63"; // BS Roformer SW: vocals, bass, drums, guitar, piano, other
export const MVSEP_OUTPUT_FORMAT = "0"; // MP3 320kbps
export const MVSEP_POLL_INTERVAL_MS = 10_000; // 10 seconds between polls
export const MVSEP_MAX_POLL_ATTEMPTS = 60; // 10 minutes max
export const MVSEP_API_BASE = "https://mvsep.com/api/separation";
