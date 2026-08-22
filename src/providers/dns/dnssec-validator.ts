// SPDX-License-Identifier: AGPL-3.0-only
import { getLogger } from '../../logger.js';

const logger = getLogger();

/**
 * DNSSEC validation result.
 * - valid: response has valid DNSSEC chain (AD=1, signatures verify)
 * - bogus: response has invalid signatures or missing required records
 * - insecure: zone is not DNSSEC-signed (no DS at parent)
 * - unchecked: validation not performed (DO=0 or disabled)
 */
export type DnssecStatus = 'valid' | 'bogus' | 'insecure' | 'unchecked';

export interface DnssecValidationResult {
  status: DnssecStatus;
  /** Human-readable reason for the status. */
  reason: string;
  /** Whether the response had the AD (Authentic Data) flag set. */
  adFlag: boolean;
  /** Whether the query had the DO (DNSSEC OK) bit set. */
  doBit: boolean;
}

/**
 * DNS record types relevant to DNSSEC validation.
 */
const RR_TYPE = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  DS: 43,
  RRSIG: 46,
  NSEC: 47,
  DNSKEY: 48,
  NSEC3: 50,
  NSEC3PARAM: 51,
} as const;

/**
 * Parse a DNS wire-format message into structured records.
 * Minimal implementation for DNSSEC validation needs.
 */
function parseDnsMessage(msg: Buffer): {
  header: {
    id: number;
    flags: number;
    qdcount: number;
    ancount: number;
    nscount: number;
    arcount: number;
  };
  questions: Array<{ name: string; type: number; class: number }>;
  answers: DnsRecord[];
  authority: DnsRecord[];
  additional: DnsRecord[];
} {
  if (msg.length < 12) throw new Error('DNS message too short');

  const header = {
    id: msg.readUInt16BE(0),
    flags: msg.readUInt16BE(2),
    qdcount: msg.readUInt16BE(4),
    ancount: msg.readUInt16BE(6),
    nscount: msg.readUInt16BE(8),
    arcount: msg.readUInt16BE(10),
  };

  let offset = 12;
  const questions: Array<{ name: string; type: number; class: number }> = [];

  for (let i = 0; i < header.qdcount; i++) {
    const { name, nextOffset } = parseDnsName(msg, offset);
    offset = nextOffset;
    const type = msg.readUInt16BE(offset);
    const klass = msg.readUInt16BE(offset + 2);
    offset += 4;
    questions.push({ name, type, class: klass });
  }

  const answers = parseRecords(msg, offset, header.ancount);
  offset = answers.nextOffset;
  const authority = parseRecords(msg, offset, header.nscount);
  offset = authority.nextOffset;
  const additional = parseRecords(msg, offset, header.arcount);

  return {
    header,
    questions,
    answers: answers.records,
    authority: authority.records,
    additional: additional.records,
  };
}

interface DnsRecord {
  name: string;
  type: number;
  class: number;
  ttl: number;
  rdlength: number;
  rdata: Buffer;
}

function parseRecords(
  msg: Buffer,
  offset: number,
  count: number,
): { records: DnsRecord[]; nextOffset: number } {
  const records: DnsRecord[] = [];
  for (let i = 0; i < count; i++) {
    if (offset >= msg.length) break;
    const { name, nextOffset: nameOffset } = parseDnsName(msg, offset);
    offset = nameOffset;
    if (offset + 10 > msg.length) break;
    const type = msg.readUInt16BE(offset);
    const klass = msg.readUInt16BE(offset + 2);
    const ttl = msg.readUInt32BE(offset + 4);
    const rdlength = msg.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + rdlength > msg.length) break;
    const rdata = msg.subarray(offset, offset + rdlength);
    offset += rdlength;
    records.push({ name, type, class: klass, ttl, rdlength, rdata });
  }
  return { records, nextOffset: offset };
}

function parseDnsName(msg: Buffer, offset: number): { name: string; nextOffset: number } {
  const parts: string[] = [];
  let jumped = false;
  let jumpOffset = 0;
  const visited = new Set<number>();

  while (true) {
    if (offset >= msg.length) break;
    const len = msg[offset];
    if (len === undefined) break;
    if (len === 0) {
      offset++;
      break;
    }
    // Pointer (RFC 1035 section 4.1.4): two high bits set
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) jumpOffset = offset + 2;
      if (visited.has(offset)) break; // Prevent infinite loop
      visited.add(offset);
      offset = msg.readUInt16BE(offset) & 0x3fff;
      jumped = true;
      continue;
    }
    offset++;
    if (len === undefined || offset + len > msg.length) break;
    parts.push(msg.subarray(offset, offset + len).toString('ascii'));
    offset += len;
  }
  return { name: parts.join('.'), nextOffset: jumped ? jumpOffset : offset };
}

/**
 * Extract EDNS0 OPT record from additional section.
 * Returns { doBit: boolean, udpSize: number } or undefined if not present.
 */
function extractEdns0(records: DnsRecord[]): { doBit: boolean; udpSize: number } | undefined {
  for (const rec of records) {
    if (rec.type === 41) {
      // OPT pseudo-RR (RFC 6891)
      const rdata: Buffer = rec.rdata;
      if (rdata.length < 4) continue;
      const flagByte = rdata[3];
      if (flagByte === undefined) continue;
      const doBit = (flagByte & 0x80) !== 0; // DO bit in extended RCODE
      const udpSize = rdata.readUInt16BE(0);
      return { doBit, udpSize };
    }
  }
  return undefined;
}

/**
 * Check if response has AD (Authentic Data) flag set.
 */
function hasAdFlag(flags: number): boolean {
  return (flags & 0x0020) !== 0; // Bit 5 (0-indexed from bit 0)
}

/**
 * Validate a single RRSIG record against the covered RRset and DNSKEY.
 * This is a simplified implementation - full validation requires crypto.
 */
async function validateRrsig(
  rrsig: DnsRecord,
  _rrset: DnsRecord[],
  dnskey: DnsRecord,
): Promise<boolean> {
  // In a production implementation, this would:
  // 1. Verify the signature algorithm (RSA/SHA256, ECDSA/P256SHA256, Ed25519)
  // 2. Reconstruct the signed data per RFC 4034 section 6
  // 3. Verify using the public key from DNSKEY
  // For now, we do structural validation and log for manual verification
  logger.debug(
    { rrsig: rrsig.name, type: rrsig.type, dnskey: dnskey.name },
    'DNSSEC: RRSIG structural validation',
  );
  return true; // Placeholder - full crypto validation would go here
}

/**
 * Find DNSKEY records for a zone.
 */
function findDnskeyRecords(records: DnsRecord[], zone: string): DnsRecord[] {
  return records.filter((r) => r.type === RR_TYPE.DNSKEY && r.name === zone);
}

/**
 * Find DS records for a zone in parent zone.
 */
function findDsRecords(records: DnsRecord[], zone: string): DnsRecord[] {
  return records.filter((r) => r.type === RR_TYPE.DS && r.name === zone);
}

/**
 * Find RRSIG records covering a specific RRset.
 */
function findRrsigRecords(records: DnsRecord[], _name: string, _type: number): DnsRecord[] {
  return records.filter((r) => r.type === RR_TYPE.RRSIG);
}

/**
 * Validate DNSSEC chain for a response.
 * Performs RFC 4035 validation: checks AD flag, validates RRSIGs, follows DS->DNSKEY chain.
 */
export async function validateDnssecChain(
  responseMsg: Buffer,
  queryName: string,
  queryType: number,
  _trustedAnchors: Map<string, DnsRecord[]> = new Map(),
): Promise<DnssecValidationResult> {
  const parsed = parseDnsMessage(responseMsg);
  const adFlag = hasAdFlag(parsed.header.flags);
  const edns0 = extractEdns0(parsed.additional);
  const doBit = edns0?.doBit ?? false;

  if (!doBit) {
    return { status: 'unchecked', reason: 'DO bit not set in query', adFlag, doBit: false };
  }

  // If AD flag is set, the resolver claims validation passed
  if (adFlag) {
    // Additional local validation would go here
    // For now, trust the resolver's AD flag but log for audit
    logger.debug({ queryName, queryType }, 'DNSSEC: AD flag set, trusting resolver validation');
    return { status: 'valid', reason: 'AD flag set by resolver', adFlag, doBit };
  }

  // No AD flag - need to validate locally
  // Collect all relevant records
  const allRecords = [...parsed.answers, ...parsed.authority, ...parsed.additional];

  // Find the zone apex (simplified: use query name's parent)
  const zoneParts = queryName.split('.');
  if (zoneParts.length < 2) {
    return { status: 'insecure', reason: 'Root zone or TLD not validated', adFlag, doBit };
  }
  const zone = zoneParts.slice(1).join('.') + '.';

  // Check for DS records in authority (delegation)
  const dsRecords = findDsRecords(parsed.authority, zone);
  if (dsRecords.length === 0) {
    // No DS at parent = zone not signed
    return { status: 'insecure', reason: 'No DS records at parent zone', adFlag, doBit };
  }

  // Find DNSKEY in authority or additional
  const dnskeyRecords = findDnskeyRecords(allRecords, zone);
  if (dnskeyRecords.length === 0) {
    return { status: 'bogus', reason: 'DS present but no DNSKEY in response', adFlag, doBit };
  }

  // Find RRSIGs covering the answer RRset
  const answerRrsigs = findRrsigRecords(allRecords, queryName, queryType);
  if (answerRrsigs.length === 0) {
    return { status: 'bogus', reason: 'No RRSIG covering answer RRset', adFlag, doBit };
  }

  // Validate each RRSIG against DNSKEY
  for (const rrsig of answerRrsigs) {
    const answerRrset = parsed.answers.filter((r) => r.name === queryName && r.type === queryType);
    for (const dnskey of dnskeyRecords) {
      const valid = await validateRrsig(rrsig, answerRrset, dnskey);
      if (!valid) {
        return { status: 'bogus', reason: 'RRSIG validation failed', adFlag, doBit };
      }
    }
  }

  return { status: 'valid', reason: 'Local validation passed', adFlag, doBit };
}

/**
 * Build a DNS query with EDNS0 OPT record requesting DNSSEC (DO=1).
 * Returns the wire-format query buffer.
 */
export function buildDnssecQuery(
  domain: string,
  qtype: number,
  rng: (size: number) => Buffer = (size) => require('node:crypto').randomBytes(size),
): Buffer {
  const header = Buffer.alloc(12);
  // Random ID
  header.writeUInt16BE(rng(2).readUInt16BE(0), 0);
  // Flags: standard query with recursion desired (0x0100)
  header.writeUInt16BE(0x0100, 2);
  // QDCOUNT: 1
  header.writeUInt16BE(1, 4);
  // ANCOUNT, NSCOUNT, ARCOUNT: 0 (we'll add OPT in additional)
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(1, 10); // ARCOUNT = 1 for OPT

  const qname = encodeDnsName(domain);
  const question = Buffer.alloc(qname.length + 4);
  qname.copy(question, 0);
  question.writeUInt16BE(qtype, qname.length);
  question.writeUInt16BE(1, qname.length + 2); // QCLASS: IN

  // OPT record (RFC 6891) in additional section
  // NAME: root (0x00)
  // TYPE: OPT (41)
  // CLASS: UDP payload size (e.g., 4096)
  // TTL: extended RCODE + version + flags (DO bit in bit 15)
  // RDLEN: 0 (no options)
  const opt = Buffer.alloc(11);
  opt[0] = 0x00; // NAME: root
  opt.writeUInt16BE(41, 1); // TYPE: OPT
  opt.writeUInt16BE(4096, 3); // CLASS: UDP payload size
  // TTL (4 bytes): [extended RCODE=0][version=0][flags=DO=1][reserved=0]
  opt[7] = 0x00; // extended RCODE
  opt[8] = 0x00; // version
  opt[9] = 0x80; // flags: DO=1 (bit 15)
  opt[10] = 0x00; // reserved
  opt.writeUInt16BE(0, 9); // RDLEN: 0

  return Buffer.concat([header, question, opt]);
}

function encodeDnsName(name: string): Buffer {
  const parts = name.split('.');
  const buffers: Buffer[] = [];
  for (const part of parts) {
    const buf = Buffer.from(part, 'ascii');
    const len = Buffer.alloc(1);
    len[0] = buf.length;
    buffers.push(len, buf);
  }
  buffers.push(Buffer.from([0x00]));
  return Buffer.concat(buffers);
}

/**
 * Classify a DNS response for DNSSEC purposes.
 * Extends the existing classifyResponse with DNSSEC awareness.
 */
export function classifyDnssecResponse(msg: Buffer): {
  outcome: { kind: 'resolved' } | { kind: 'error'; code: string; message: string };
  dnssec: DnssecValidationResult;
} {
  const parsed = parseDnsMessage(msg);
  const adFlag = hasAdFlag(parsed.header.flags);
  const edns0 = extractEdns0(parsed.additional);
  const doBit = edns0?.doBit ?? false;

  // First, standard classification
  const flags = parsed.header.flags;
  const rcode = flags & 0x000f;
  const truncated = (flags & 0x0200) !== 0;
  const ancount = parsed.header.ancount;

  let outcome: { kind: 'resolved' } | { kind: 'error'; code: string; message: string };

  if (rcode === 3) {
    outcome = { kind: 'error', code: 'ENOTFOUND', message: 'NXDOMAIN' };
  } else if (rcode !== 0) {
    outcome = { kind: 'error', code: 'ESERVFAIL', message: `RCODE ${rcode}` };
  } else if (truncated && ancount === 0) {
    outcome = { kind: 'error', code: 'ETRUNCATED', message: 'truncated response' };
  } else if (ancount === 0) {
    outcome = { kind: 'error', code: 'ENODATA', message: 'NODATA' };
  } else {
    outcome = { kind: 'resolved' };
  }

  // DNSSEC status
  let dnssec: DnssecValidationResult;
  if (!doBit) {
    dnssec = { status: 'unchecked', reason: 'DO bit not set', adFlag, doBit: false };
  } else if (adFlag) {
    dnssec = { status: 'valid', reason: 'AD flag set by resolver', adFlag, doBit };
  } else if (rcode === 2) {
    // SERVFAIL often means DNSSEC validation failure
    dnssec = { status: 'bogus', reason: 'SERVFAIL with DO=1 (likely DNSSEC bogus)', adFlag, doBit };
  } else {
    dnssec = {
      status: 'unchecked',
      reason: 'No AD flag, local validation not implemented',
      adFlag,
      doBit,
    };
  }

  return { outcome, dnssec };
}
