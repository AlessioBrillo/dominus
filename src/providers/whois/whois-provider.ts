export interface WhoisResult {
  domain: string;
  available: boolean;
  registrar?: string | undefined;
  createdDate?: string | undefined;
  expiryDate?: string | undefined;
  checkedAt: string;
}

export interface WhoisProvider {
  checkAvailability(domain: string, signal?: AbortSignal): Promise<WhoisResult>;
}
