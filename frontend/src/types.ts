export enum Door {
  CLINICAL_FINDING = 'Clinical Finding',
  PROCEDURE_ACTION = 'Procedure / Action',
  SITUATION_CONTEXT = 'Situation / Context',
  OBSERVABLE_ENTITY = 'Observable Entity'
}

export interface SubOption {
  id: string;
  label: string;
  ecl: string;
}

export interface Concept {
  id: string;
  term: string;
  descendant_count?: number;
}

export interface AttributeFilterOption {
  valueId: string;
  label: string;
  count: number;
  checked: boolean;
}

export interface AttributeFilter {
  attributeId: string;
  name: string;
  options: AttributeFilterOption[];
}

export interface CriterionRule {
  id: string; // unique local ID for React lists
  concept_id: number;
  term: string;
  include_self: boolean;
  is_exclusion: boolean;
  attributes: {
    type_id: number;
    value_ids: number[];
    attributeName?: string;
    valueTerms?: string[];
  }[];
}

export interface EvaluationMetrics {
  coverage: number;
  purity: number;
  positives_count: number;
  true_positives_count: number;
  false_positives_count: number;
  false_negatives_count: number;
  total_target_codes: number;
}

export interface ConceptItem {
  id: string;
  term: string;
}

export interface EvaluationResult {
  metrics: EvaluationMetrics;
  positives: ConceptItem[];
  true_positives: ConceptItem[];
  false_positives: ConceptItem[];
  false_negatives: ConceptItem[];
  generated_ecl: string;
}

export interface LegacyRefsetDetails {
  total_count: number;
  active_count: number;
  inactive_count: number;
  inactive_codes: string[];
}

export interface ReviewSummaryItem {
  id: string;
  target_refset: string;
  is_draft: boolean;
  filename: string;
  title: string;
}

export interface SavedDraft {
  draft_id: string;
  target_refset: string;
  snomed_release: string;
  reviewer: string;
  updated_at: string;
  notes: string;
  inclusions: any[];
  exclusions: any[];
  metrics?: EvaluationMetrics;
  generated_ecl?: string;
}

export interface ReviewFileContent {
  id: string;
  is_draft: boolean;
  target_refset: string;
  snomed_release: string;
  markdown_report?: string;
  recommendations?: string;
  target_codes: string[];
  legacy_details?: LegacyRefsetDetails;
  initial_inclusions: any[];
  initial_exclusions: any[];
  draft?: SavedDraft;
  raw_json: any;
}
