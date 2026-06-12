export interface StageResult<T> {
  passed: T[];
  filtered: T[];
  stageName: string;
  durationMs: number;
}

export interface Stage<TIn, TOut = TIn> {
  readonly name: string;
  process(items: TIn[], signal?: AbortSignal): Promise<StageResult<TOut>>;
}
