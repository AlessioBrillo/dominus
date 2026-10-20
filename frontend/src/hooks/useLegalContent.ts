// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { getLegalContent, type LegalDocumentSlug } from '@/api/legal';

/**
 * The legal documents of this deployment.
 *
 * The text is served by the backend, so the operator identity is the one
 * the deployment was configured with, and the community edition and the
 * managed service show the documents that actually apply to them.
 */
export function useLegalContent() {
  return useQuery({
    queryKey: ['legal', 'content'] as const,
    queryFn: getLegalContent,
    staleTime: 5 * 60_000,
  });
}

/** The document with the given slug, or undefined while it is loading. */
export function useLegalDocument(slug: LegalDocumentSlug) {
  const query = useLegalContent();
  return {
    ...query,
    document: query.data?.documents.find((d) => d.slug === slug),
    mode: query.data?.mode,
  };
}
