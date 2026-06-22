export interface WaybackResult {
  domain: string;
  domainAge: number;
  waybackSnapshots: number;
  checkedAt: string;
}

export interface WaybackProvider {
  getExpiryData(domain: string, signal?: AbortSignal): Promise<WaybackResult>;
}
