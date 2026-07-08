export enum Verdict {
  Keep = 'keep',
  Drop = 'drop',
  Reprice = 'reprice',
}

export interface RenewalClockData {
  domain: string;
  renewalDate: string;
  daysUntilRenewal: number;
  renewalCost: number;
}

export interface PortfolioEntry {
  id?: number;
  domain: string;
  tld: string;
  acquiredAt: string;
  renewalDate: string;
  acquisitionCost: number;
  renewalCost: number;
  registrar: string;
  currentScore?: number | undefined;
  suggestedListPrice?: number | undefined;
  verdict: Verdict;
  verdictReason?: string | undefined;
  verdictUpdatedAt?: string | undefined;
  notes?: string | undefined;
  lastRdapVerifiedAt?: string | undefined;
  lastWhoisRenewalDate?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface AddPortfolioEntryInput {
  domain: string;
  tld: string;
  acquiredAt: string;
  renewalDate: string;
  acquisitionCost: number;
  renewalCost: number;
  registrar: string;
  notes?: string | undefined;
}
