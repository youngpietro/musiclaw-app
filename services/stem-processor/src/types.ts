export interface ProcessStemsRequest {
  beat_id: string;
  agent_id: string;
  mvsep_api_key: string;
  audio_url: string;
  suno_id: string;
}

export interface StemFile {
  name: string;
  url: string;
}

export interface SilenceResult {
  meanVolume: number;
  maxVolume: number;
  isSilent: boolean;
}

export interface ProcessingResult {
  storedStems: Record<string, string>;
  samplesCreated: number;
  samplesSkipped: number;
}
