const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const CACHE_MAX = 100;

interface OgScoreData {
  domain: string;
  expectedValue: number;
  confidence: number;
  weightedScore: number;
  recommended: boolean;
  trademark: string;
}

interface CacheEntry {
  png: Buffer;
  createdAt: number;
}

const pngCache = new Map<string, CacheEntry>();

function getCacheKey(domain: string): string {
  return `og:${domain.toLowerCase()}`;
}

function renderOgSvg(data: OgScoreData): string {
  const verdictColor = data.recommended ? '#22c55e' : '#ef4444';
  const verdictText = data.recommended ? 'BUY' : 'PASS';
  const tmColor =
    data.trademark === 'clear' ? '#22c55e' : data.trademark === 'blocked' ? '#ef4444' : '#f97316';

  return `<svg width="${OG_WIDTH}" height="${OG_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a0a0f"/>
      <stop offset="100%" stop-color="#18181b"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#818cf8"/>
      <stop offset="100%" stop-color="#6366f1"/>
    </linearGradient>
  </defs>
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#bg)" rx="16"/>
  <rect x="0" y="0" width="6" height="${OG_HEIGHT}" fill="url(#accent)"/>
  <text x="48" y="80" font-family="system-ui, -apple-system, sans-serif" font-size="18" fill="#a1a1aa" font-weight="500">DOMINUS</text>
  <text x="48" y="160" font-family="system-ui, -apple-system, sans-serif" font-size="48" fill="#e4e4e7" font-weight="700">${escapeXml(data.domain)}</text>
  <text x="48" y="200" font-family="system-ui, -apple-system, sans-serif" font-size="20" fill="#71717a">Domain Investment Score</text>

  <!-- Metrics row -->
  <rect x="48" y="260" width="250" height="100" rx="8" fill="#27272a"/>
  <text x="68" y="290" font-family="system-ui, -apple-system, sans-serif" font-size="14" fill="#a1a1aa" font-weight="500">EXPECTED VALUE</text>
  <text x="68" y="335" font-family="system-ui, -apple-system, sans-serif" font-size="36" fill="#e4e4e7" font-weight="700">€${data.expectedValue.toFixed(0)}</text>

  <rect x="326" y="260" width="250" height="100" rx="8" fill="#27272a"/>
  <text x="346" y="290" font-family="system-ui, -apple-system, sans-serif" font-size="14" fill="#a1a1aa" font-weight="500">CONFIDENCE</text>
  <text x="346" y="335" font-family="system-ui, -apple-system, sans-serif" font-size="36" fill="#e4e4e7" font-weight="700">${(data.confidence * 100).toFixed(0)}%</text>

  <rect x="604" y="260" width="250" height="100" rx="8" fill="#27272a"/>
  <text x="624" y="290" font-family="system-ui, -apple-system, sans-serif" font-size="14" fill="#a1a1aa" font-weight="500">WEIGHTED SCORE</text>
  <text x="624" y="335" font-family="system-ui, -apple-system, sans-serif" font-size="36" fill="#e4e4e7" font-weight="700">${data.weightedScore.toFixed(1)}</text>

  <!-- Verdict + Trademark badges -->
  <rect x="48" y="400" width="120" height="40" rx="20" fill="${verdictColor}" opacity="0.15"/>
  <text x="108" y="426" font-family="system-ui, -apple-system, sans-serif" font-size="16" fill="${verdictColor}" font-weight="700" text-anchor="middle">${verdictText}</text>

  <rect x="190" y="400" width="160" height="40" rx="20" fill="${tmColor}" opacity="0.15"/>
  <text x="270" y="426" font-family="system-ui, -apple-system, sans-serif" font-size="16" fill="${tmColor}" font-weight="600" text-anchor="middle">TM: ${data.trademark.toUpperCase()}</text>

  <text x="48" y="530" font-family="system-ui, -apple-system, sans-serif" font-size="14" fill="#52525b">dominus.app — Free Domain Investment Intelligence</text>
</svg>`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export async function generateOgPng(domain: string, score: OgScoreData): Promise<Buffer> {
  const key = getCacheKey(domain);

  const existing = pngCache.get(key);
  if (existing && Date.now() - existing.createdAt < 300_000) {
    return existing.png;
  }

  if (pngCache.size >= CACHE_MAX) {
    const oldest = pngCache.entries().next();
    if (oldest.value) {
      pngCache.delete(oldest.value[0]);
    }
  }

  const svg = renderOgSvg(score);
  let png: Buffer;
  try {
    const sharp = (await import('sharp')).default;
    png = await sharp(Buffer.from(svg)).png().toBuffer();
  } catch {
    png = Buffer.from(svg);
  }

  pngCache.set(key, { png, createdAt: Date.now() });
  return png;
}

export function invalidateOgCache(domain: string): void {
  pngCache.delete(getCacheKey(domain));
}
