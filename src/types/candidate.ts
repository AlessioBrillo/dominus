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
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}
