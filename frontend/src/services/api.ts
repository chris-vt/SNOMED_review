import { 
  ReviewSummaryItem, 
  ReviewFileContent, 
  EvaluationResult, 
  Concept, 
  AttributeFilter, 
  SavedDraft 
} from '../types';

export async function fetchReviews(): Promise<ReviewSummaryItem[]> {
  const res = await fetch('/api/reviews');
  if (!res.ok) throw new Error('Failed to load reviews');
  return res.json();
}

export async function fetchReview(id: string): Promise<ReviewFileContent> {
  const res = await fetch(`/api/reviews/${id}`);
  if (!res.ok) throw new Error(`Failed to load review: ${id}`);
  return res.json();
}

export async function saveDraft(draft: SavedDraft): Promise<{ draft_id: string; message: string }> {
  const res = await fetch('/api/reviews/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft }),
  });
  if (!res.ok) throw new Error('Failed to save draft');
  return res.json();
}

export async function deleteDraft(draftId: string): Promise<{ success: boolean; message: string }> {
  const res = await fetch(`/api/reviews/draft/${encodeURIComponent(draftId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete draft');
  return res.json();
}

export async function evaluateCriteria(
  target_refset: string,
  inclusions: any[],
  exclusions: any[]
): Promise<EvaluationResult> {
  const res = await fetch('/api/reviews/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_refset, inclusions, exclusions }),
  });
  if (!res.ok) throw new Error('Failed to evaluate criteria');
  return res.json();
}

export async function searchConcepts(query: string): Promise<Concept[]> {
  if (!query.trim()) return [];
  const res = await fetch(`/api/snomed/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error('Failed to search concepts');
  return res.json();
}

export async function introspectAttributes(conceptId: string): Promise<AttributeFilter[]> {
  const res = await fetch(`/api/snomed/attributes/introspect?concept_id=${conceptId}&include_self=true`);
  if (!res.ok) throw new Error('Failed to introspect attributes');
  const data = await res.json();
  
  // Transform raw backend facets into UI AttributeFilter format
  return data.map((facet: any) => ({
    attributeId: facet.attribute_id.toString(),
    name: facet.attribute_term,
    options: facet.options.map((opt: any) => ({
      valueId: opt.value_id.toString(),
      label: opt.value_term,
      count: opt.count,
      checked: false,
    })),
  }));
}

export async function previewFilteredCodes(
  conceptId: string,
  attributes: { type_id: number; value_ids: number[] }[]
): Promise<{ total_count: number; codes: Concept[] }> {
  const res = await fetch('/api/snomed/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      concept_id: parseInt(conceptId, 10),
      include_self: true,
      attributes,
    }),
  });
  if (!res.ok) throw new Error('Failed to preview filtered codes');
  return res.json();
}

