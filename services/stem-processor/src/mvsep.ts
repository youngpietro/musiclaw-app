import {
  MVSEP_API_BASE,
  MVSEP_SEP_TYPE,
  MVSEP_OUTPUT_FORMAT,
  MVSEP_POLL_INTERVAL_MS,
  MVSEP_MAX_POLL_ATTEMPTS,
} from "./constants";
import type { StemFile } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Create a separation job on MVSEP.
 * Returns the short hash used for polling.
 */
export async function createSeparation(
  apiKey: string,
  audioUrl: string
): Promise<string> {
  const formData = new URLSearchParams();
  formData.append("api_token", apiKey);
  formData.append("url", audioUrl);
  formData.append("sep_type", MVSEP_SEP_TYPE);
  formData.append("output_format", MVSEP_OUTPUT_FORMAT);

  const res = await fetch(`${MVSEP_API_BASE}/create`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });

  const body = await res.text();
  console.log(`MVSEP create: ${res.status} ${body.slice(0, 500)}`);

  if (!res.ok) {
    throw new Error(
      `MVSEP create failed: ${res.status} ${body.slice(0, 200)}`
    );
  }

  const data = JSON.parse(body);
  const hash = data.data?.hash || data.hash;
  if (!hash) {
    throw new Error(`MVSEP: no hash in response: ${body.slice(0, 200)}`);
  }

  return hash;
}

/**
 * Poll MVSEP for completion using the two-hop pattern:
 * 1. get-remote (short hash) → returns status + final long hash when done
 * 2. get (long hash) → returns actual stem files
 *
 * Polls every MVSEP_POLL_INTERVAL_MS, up to MVSEP_MAX_POLL_ATTEMPTS times.
 */
export async function pollForCompletion(hash: string): Promise<StemFile[]> {
  for (let attempt = 0; attempt < MVSEP_MAX_POLL_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(MVSEP_POLL_INTERVAL_MS);

    // Step 1: poll get-remote with short hash
    const remoteRes = await fetch(
      `${MVSEP_API_BASE}/get-remote?hash=${hash}`
    );
    if (!remoteRes.ok) {
      console.warn(`MVSEP get-remote HTTP ${remoteRes.status}`);
      continue;
    }

    const remoteData: any = await remoteRes.json();
    const status = remoteData.status || "";
    console.log(
      `MVSEP poll ${attempt + 1}/${MVSEP_MAX_POLL_ATTEMPTS}: status=${status}`
    );

    if (status === "done") {
      // Step 2: extract final hash and fetch stems
      const finalHash = remoteData.data?.hash;
      if (!finalHash) {
        throw new Error(
          `MVSEP: get-remote done but no final hash: ${JSON.stringify(remoteData)}`
        );
      }

      const getRes = await fetch(
        `${MVSEP_API_BASE}/get?hash=${encodeURIComponent(finalHash)}`
      );
      if (!getRes.ok) {
        throw new Error(`MVSEP get failed: ${getRes.status}`);
      }

      const getData: any = await getRes.json();
      const files = getData.data?.files || getData.files || [];
      const stemFiles: StemFile[] = [];

      for (const file of files) {
        const url = file.url || file.file_url || file;
        // MVSEP uses "type" field for stem name (e.g. "Vocals", "Bass", "Drums")
        const name = file.type || file.name || file.file_name || "";
        if (url && typeof url === "string") {
          stemFiles.push({ name, url });
        }
      }

      return stemFiles;
    } else if (status === "failed" || status === "error") {
      throw new Error(`MVSEP separation failed: ${JSON.stringify(remoteData)}`);
    }
    // status is "waiting", "processing", "distributing", "merging" — keep polling
  }

  throw new Error(
    `MVSEP polling timed out after ${MVSEP_MAX_POLL_ATTEMPTS} attempts (${Math.round((MVSEP_MAX_POLL_ATTEMPTS * MVSEP_POLL_INTERVAL_MS) / 1000)}s)`
  );
}
