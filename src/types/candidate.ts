export enum CandidateSource {
  KeywordCombo = 'keyword_combo',
  Brandable = 'brandable',
  CloseoutCsv = 'closeout_csv',
}

export enum CandidateStatus {
  Pending = 'pending',
  DnsFiltered = 'dns_filtered',
  RdapFiltered = 'rdap_filtered',
  Scored = 'scored',
  TrademarkBlocked = 'trademark_blocked',
  Recommended = 'recommended',
  Unscored = 'unscored',
}

/**
 * Closeout-specific scoring inputs that ride along with a candidate from import
 * to the scoring engine, where they feed the expiry signal. All optional: a row
 * may omit any of them and the signal degrades gracefully.
 */
export interface CloseoutMeta {
  domainAge?: number | undefined;
  backlinks?: number | undefined;
  waybackSnapshots?: number | undefined;
}

/** One parsed row from a closeout CSV: a domain plus its optional metadata. */
export interface CloseoutEntry extends CloseoutMeta {
  domain: string;
}

export interface RawCandidate {
  domain: string;
  source: CandidateSource;
  pipelineRunId: string;
}

export interface CloseoutEntry {
  domain: string;
  domainAge?: number | undefined;
  backlinks?: number | undefined;
  waybackSnapshots?: number | undefined;
}

export interface DomainCandidate extends RawCandidate {
  id?: number;
  tld: string;
  status: CandidateStatus;
  dnsStatus?: string | undefined;
  rdapStatus?: string | undefined;
  isPremium: boolean;
  closeoutMeta?: CloseoutMeta | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}
