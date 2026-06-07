export interface WhoisResult {
  domain: string;
  available: boolean;
  registrar?: string | undefined;
  expiryDate?: string | undefined;
  checkedAt: string;
}

export interface WhoisProvider {
  checkAvailability(domain: string): Promise<WhoisResult>;
}
