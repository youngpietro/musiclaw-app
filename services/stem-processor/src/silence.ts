import { execFile } from "child_process";
import { promisify } from "util";
import { SILENCE_THRESHOLD_DB } from "./constants";
import type { SilenceResult } from "./types";

const execFileAsync = promisify(execFile);

/**
 * Detect silence in an audio file using ffmpeg's volumedetect filter.
 * Returns mean/max volume in dB and whether the file is considered silent.
 *
 * Proven results from testing:
 *   bass:   -15.6 dB (audio)
 *   drums:  -22.3 dB (audio)
 *   guitar: -91.0 dB (SILENT)
 *   piano:  -91.0 dB (SILENT)
 *   vocals: -91.0 dB (SILENT)
 */
export async function detectSilence(filePath: string): Promise<SilenceResult> {
  try {
    const { stderr } = await execFileAsync("ffmpeg", [
      "-i",
      filePath,
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ]);

    const meanMatch = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);
    const maxMatch = stderr.match(/max_volume:\s*([-\d.]+)\s*dB/);

    const meanVolume = meanMatch ? parseFloat(meanMatch[1]) : -91;
    const maxVolume = maxMatch ? parseFloat(maxMatch[1]) : -91;

    return {
      meanVolume,
      maxVolume,
      isSilent: meanVolume < SILENCE_THRESHOLD_DB,
    };
  } catch (err) {
    console.error(
      `ffmpeg volumedetect failed for ${filePath}:`,
      (err as Error).message
    );
    // If ffmpeg fails, assume not silent (don't skip potentially valid stems)
    return { meanVolume: 0, maxVolume: 0, isSilent: false };
  }
}
