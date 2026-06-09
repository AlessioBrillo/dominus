export interface AutoTunerConfig {
  enabled: boolean;
  minSampleSize: number;
  maxDeltaPerSignal: number;
  maxTotalDriftFromDefaults: number;
  dryRun: boolean;
}

export const DEFAULT_AUTO_TUNER_CONFIG: AutoTunerConfig = {
  enabled: false,
  minSampleSize: 20,
  maxDeltaPerSignal: 0.05,
  maxTotalDriftFromDefaults: 0.2,
  dryRun: true,
};
