import { readFileSync, existsSync } from 'node:fs';
import type { KeywordMetrics, KeywordProvider } from './keyword-provider.js';

export class ManualKeywordProvider implements KeywordProvider {
  private readonly data: Map<string, KeywordMetrics>;

  constructor(dataFilePath?: string) {
    this.data = new Map();
    if (dataFilePath && existsSync(dataFilePath)) {
      const raw = JSON.parse(readFileSync(dataFilePath, 'utf-8')) as KeywordMetrics[];
      for (const entry of raw) {
        this.data.set(entry.term.toLowerCase(), entry);
      }
    }
  }

  getMetrics(term: string): Promise<KeywordMetrics> {
    const key = term.toLowerCase();
    const found = this.data.get(key);
    if (found !== undefined) return Promise.resolve(found);
    return Promise.resolve({ term, monthlySearchVolume: 0, cpc: 0, competition: 0 });
  }
}
