import { useState } from 'react';
import { Share2, Check, Loader2 } from 'lucide-react';
import { shareScore } from '@/api/public';
import { Button } from '@/components/ui/button';

interface ShareButtonProps {
  domain: string;
  variant?: 'default' | 'outline' | 'ghost';
  size?: 'sm' | 'default' | 'lg';
}

export function ShareButton({ domain, variant = 'ghost', size = 'sm' }: ShareButtonProps) {
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleShare() {
    setLoading(true);
    try {
      const result = await shareScore(domain);
      const fullUrl = `${window.location.origin}${result.url}`;
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to share score:', err);
    } finally {
      setLoading(false);
    }
  }

  if (copied) {
    return (
      <Button variant="outline" size={size} disabled>
        <Check className="mr-1 h-4 w-4" />
        Copied!
      </Button>
    );
  }

  return (
    <Button variant={variant} size={size} onClick={handleShare} disabled={loading}>
      {loading ? (
        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
      ) : (
        <Share2 className="mr-1 h-4 w-4" />
      )}
      Share
    </Button>
  );
}
