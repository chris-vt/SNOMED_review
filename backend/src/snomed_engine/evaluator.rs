use super::model::SnomedEngine;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttributeFilterSpec {
    pub type_id: u64,
    pub value_ids: Vec<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CriterionSpec {
    pub concept_id: u64,
    pub term: Option<String>,
    pub include_self: bool,
    pub attributes: Vec<AttributeFilterSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttributeOptionCount {
    pub value_id: u64,
    pub value_term: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttributeFacet {
    pub attribute_id: u64,
    pub attribute_term: String,
    pub options: Vec<AttributeOptionCount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluationMetrics {
    pub coverage: f64,
    pub purity: f64,
    pub positives_count: usize,
    pub true_positives_count: usize,
    pub false_positives_count: usize,
    pub false_negatives_count: usize,
    pub total_target_codes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConceptItem {
    pub id: String,
    pub term: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluationResult {
    pub metrics: EvaluationMetrics,
    pub positives: Vec<ConceptItem>,
    pub true_positives: Vec<ConceptItem>,
    pub false_positives: Vec<ConceptItem>,
    pub false_negatives: Vec<ConceptItem>,
    pub generated_ecl: String,
}

impl SnomedEngine {
    /// Introspect available attributes across descendants of an anchor concept
    pub fn introspect_attributes(&self, anchor: u64, include_self: bool) -> Vec<AttributeFacet> {
        let codes = self.get_descendants(anchor, include_self);
        
        let mut facet_map: HashMap<u64, HashMap<u64, usize>> = HashMap::new();

        for code in &codes {
            if let Some(attrs) = self.attributes.get(code) {
                for &(attr_type, attr_val) in attrs {
                    *facet_map.entry(attr_type).or_default().entry(attr_val).or_default() += 1;
                }
            }
        }

        let mut facets = Vec::new();
        for (attr_type, val_map) in facet_map {
            let mut options = Vec::new();
            for (val_id, count) in val_map {
                options.push(AttributeOptionCount {
                    value_id: val_id,
                    value_term: self.get_term(val_id),
                    count,
                });
            }
            options.sort_by(|a, b| b.count.cmp(&a.count));

            facets.push(AttributeFacet {
                attribute_id: attr_type,
                attribute_term: self.get_term(attr_type),
                options,
            });
        }

        facets.sort_by(|a, b| a.attribute_term.cmp(&b.attribute_term));
        facets
    }

    /// Resolve a single criterion into matching concept IDs
    pub fn resolve_criterion(&self, crit: &CriterionSpec) -> HashSet<u64> {
        let mut candidates = self.get_descendants(crit.concept_id, crit.include_self);

        if !crit.attributes.is_empty() {
            candidates.retain(|concept_id| {
                if let Some(attrs) = self.attributes.get(concept_id) {
                    crit.attributes.iter().all(|filter| {
                        attrs.iter().any(|(t, v)| *t == filter.type_id && filter.value_ids.contains(v))
                    })
                } else {
                    false
                }
            });
        }

        candidates
    }

    /// Resolve full set of inclusions and exclusions into "Positives"
    pub fn resolve_positives(
        &self,
        inclusions: &[CriterionSpec],
        exclusions: &[CriterionSpec],
    ) -> HashSet<u64> {
        let mut positives: HashSet<u64> = HashSet::new();

        for inc in inclusions {
            let matched = self.resolve_criterion(inc);
            positives.extend(matched);
        }

        for exc in exclusions {
            let excluded = self.resolve_criterion(exc);
            positives.retain(|c| !excluded.contains(c));
        }

        positives
    }

    /// Evaluate full set of criteria against target refset codes
    pub fn evaluate_criteria(
        &self,
        inclusions: &[CriterionSpec],
        exclusions: &[CriterionSpec],
        target_refset_codes: &HashSet<u64>,
    ) -> EvaluationResult {
        let positives_set = self.resolve_positives(inclusions, exclusions);

        let mut tp_set: HashSet<u64> = HashSet::new();
        let mut fp_set: HashSet<u64> = HashSet::new();
        let mut fn_set: HashSet<u64> = HashSet::new();

        for &code in &positives_set {
            if target_refset_codes.contains(&code) {
                tp_set.insert(code);
            } else {
                fp_set.insert(code);
            }
        }

        for &code in target_refset_codes {
            if !positives_set.contains(&code) {
                fn_set.insert(code);
            }
        }

        let total_target = target_refset_codes.len();
        let total_positives = positives_set.len();

        let coverage = if total_target > 0 {
            tp_set.len() as f64 / total_target as f64
        } else {
            0.0
        };

        let purity = if total_positives > 0 {
            tp_set.len() as f64 / total_positives as f64
        } else {
            0.0
        };

        let map_to_items = |set: HashSet<u64>| -> Vec<ConceptItem> {
            let mut list: Vec<ConceptItem> = set
                .into_iter()
                .map(|id| ConceptItem {
                    id: id.to_string(),
                    term: self.get_term(id),
                })
                .collect();
            list.sort_by(|a, b| a.term.cmp(&b.term));
            list
        };

        let positives = map_to_items(positives_set);
        let true_positives = map_to_items(tp_set);
        let false_positives = map_to_items(fp_set);
        let false_negatives = map_to_items(fn_set);

        let generated_ecl = self.generate_ecl_string(inclusions, exclusions);

        EvaluationResult {
            metrics: EvaluationMetrics {
                coverage,
                purity,
                positives_count: total_positives,
                true_positives_count: true_positives.len(),
                false_positives_count: false_positives.len(),
                false_negatives_count: false_negatives.len(),
                total_target_codes: total_target,
            },
            positives,
            true_positives,
            false_positives,
            false_negatives,
            generated_ecl,
        }
    }

    pub fn generate_ecl_string(
        &self,
        inclusions: &[CriterionSpec],
        exclusions: &[CriterionSpec],
    ) -> String {
        let format_rule = |crit: &CriterionSpec| -> String {
            let prefix = if crit.include_self { "<<" } else { "<" };
            let term = self.get_term(crit.concept_id);
            let mut s = format!("{} {} |{}|", prefix, crit.concept_id, term);

            if !crit.attributes.is_empty() {
                let parts: Vec<String> = crit
                    .attributes
                    .iter()
                    .map(|f| {
                        let attr_term = self.get_term(f.type_id);
                        let val_strs: Vec<String> = f
                            .value_ids
                            .iter()
                            .map(|v| format!("{} |{}|", v, self.get_term(*v)))
                            .collect();
                        format!("{} |{}| = ({})", f.type_id, attr_term, val_strs.join(" OR "))
                    })
                    .collect();
                s.push_str(&format!(" : {}", parts.join(", ")));
            }
            s
        };

        let inc_strs: Vec<String> = inclusions.iter().map(format_rule).collect();
        let exc_strs: Vec<String> = exclusions.iter().map(|e| format!("MINUS ({})", format_rule(e))).collect();

        if inc_strs.is_empty() {
            return String::new();
        }

        let mut ecl = inc_strs.join("\nOR ");
        if !exc_strs.is_empty() {
            ecl.push_str("\n");
            ecl.push_str(&exc_strs.join("\n"));
        }
        ecl
    }
}
