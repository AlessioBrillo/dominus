export type WeightSnapshotSource = 'init' | 'manual' | 'auto-tune' | 'cli-override';

export interface WeightSnapshot {
  id: number;
  snapshotAt: string;
  intrinsic: number;
  commercial: number;
  market: number;
  expiry: number;
  source: WeightSnapshotSource;
  backtestGeneratedAt: string | null;
  sampleSize: number | null;
  notes: string | null;
}

export interface InsertWeightSnapshotInput {
  intrinsic: number;
  commercial: number;
  market: number;
  expiry: number;
  source: WeightSnapshotSource;
  backtestGeneratedAt?: string;
  sampleSize?: number;
  notes?: string;
}
