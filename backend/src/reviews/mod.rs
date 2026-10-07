use serde::{Deserialize, Serialize};
use std::collections::{HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use crate::snomed_engine::{CriterionSpec, EvaluationMetrics, SnomedEngine};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewSummaryItem {
    pub id: String,              // e.g. "AST_COD" or "AST_COD_Joe_v1"
    pub target_refset: String,   // e.g. "AST_COD"
    pub is_draft: bool,
    pub filename: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedDraft {
    pub draft_id: String,
    pub target_refset: String,
    pub snomed_release: String,
    pub reviewer: String,
    pub updated_at: String,
    pub notes: String,
    pub inclusions: Vec<CriterionSpec>,
    pub exclusions: Vec<CriterionSpec>,
    pub metrics: Option<EvaluationMetrics>,
    pub generated_ecl: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyRefsetDetails {
    pub total_count: usize,
    pub active_count: usize,
    pub inactive_count: usize,
    pub inactive_codes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewFileContent {
    pub id: String,
    pub is_draft: bool,
    pub target_refset: String,
    pub snomed_release: String,
    pub markdown_report: Option<String>,
    pub recommendations: Option<String>,
    pub target_codes: Vec<String>,
    pub legacy_details: Option<LegacyRefsetDetails>,
    pub initial_inclusions: Vec<CriterionSpec>,
    pub initial_exclusions: Vec<CriterionSpec>,
    pub draft: Option<SavedDraft>,
    pub raw_json: serde_json::Value,
}

pub struct ReviewStore {
    inputs_dir: PathBuf,
    storage_dir: PathBuf,
    legacy_csv_path: Option<PathBuf>,
}

impl ReviewStore {
    pub fn new<P1: AsRef<Path>, P2: AsRef<Path>>(inputs_dir: P1, storage_dir: P2) -> Self {
        let inputs_dir = inputs_dir.as_ref().to_path_buf();
        let storage_dir = storage_dir.as_ref().to_path_buf();
        let _ = fs::create_dir_all(&storage_dir);
        Self {
            inputs_dir,
            storage_dir,
            legacy_csv_path: None,
        }
    }

    pub fn with_legacy_csv<P: AsRef<Path>>(mut self, csv_path: P) -> Self {
        self.legacy_csv_path = Some(csv_path.as_ref().to_path_buf());
        self
    }

    /// List all base reviews and saved drafts
    pub fn list_reviews(&self) -> Vec<ReviewSummaryItem> {
        let mut items = Vec::new();

        if let Ok(entries) = fs::read_dir(&self.inputs_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) == Some("json") {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        let id = stem.trim_end_matches("_review").to_string();
                        items.push(ReviewSummaryItem {
                            id: id.clone(),
                            target_refset: id.clone(),
                            is_draft: false,
                            filename: path.file_name().unwrap().to_str().unwrap().to_string(),
                            title: format!("Agent Baseline: {}", id),
                        });
                    }
                }
            }
        }

        if let Ok(entries) = fs::read_dir(&self.storage_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) == Some("json") {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        let refset = stem.split('_').next().unwrap_or(stem).to_string();
                        items.push(ReviewSummaryItem {
                            id: stem.to_string(),
                            target_refset: refset,
                            is_draft: true,
                            filename: path.file_name().unwrap().to_str().unwrap().to_string(),
                            title: format!("Draft: {}", stem),
                        });
                    }
                }
            }
        }

        items.sort_by(|a, b| a.id.cmp(&b.id));
        items
    }

    /// Load codes from legacy CSV for a target refset
    pub fn load_legacy_refset_codes(
        &self,
        target_refset: &str,
        engine: Option<&SnomedEngine>,
    ) -> Option<(HashSet<u64>, HashSet<u64>)> {
        let csv_path = self.legacy_csv_path.as_ref()?;
        if !csv_path.exists() {
            return None;
        }

        let mut rdr = csv::ReaderBuilder::new().from_path(csv_path).ok()?;
        let mut raw_codes = HashSet::new();

        for result in rdr.records() {
            if let Ok(record) = result {
                if let (Some(cluster_id), Some(code_str)) = (record.get(0), record.get(2)) {
                    if cluster_id.trim().eq_ignore_ascii_case(target_refset) {
                        if let Ok(code) = code_str.trim().parse::<u64>() {
                            raw_codes.insert(code);
                        }
                    }
                }
            }
        }

        if raw_codes.is_empty() {
            return None;
        }

        if let Some(eng) = engine {
            let mut active = HashSet::new();
            let mut inactive = HashSet::new();
            for code in raw_codes {
                // If code is in engine, it's active in the release
                if eng.terms.contains_key(&code) || eng.children.contains_key(&code) || eng.parents.contains_key(&code) {
                    active.insert(code);
                } else {
                    inactive.insert(code);
                }
            }
            Some((active, inactive))
        } else {
            Some((raw_codes, HashSet::new()))
        }
    }

    /// Load review content or draft
    pub fn load_review(
        &self,
        id: &str,
        engine: Option<&SnomedEngine>,
    ) -> Result<ReviewFileContent, Box<dyn std::error::Error>> {
        let draft_path = self.storage_dir.join(format!("{}.json", id));
        if draft_path.exists() {
            let data = fs::read_to_string(&draft_path)?;
            let draft: SavedDraft = serde_json::from_str(&data)?;
            
            let base_content = self.load_base_review(&draft.target_refset, engine).ok();

            return Ok(ReviewFileContent {
                id: id.to_string(),
                is_draft: true,
                target_refset: draft.target_refset.clone(),
                snomed_release: draft.snomed_release.clone(),
                markdown_report: base_content.as_ref().and_then(|b| b.markdown_report.clone()),
                recommendations: base_content.as_ref().and_then(|b| b.recommendations.clone()),
                target_codes: base_content.as_ref().map(|b| b.target_codes.clone()).unwrap_or_default(),
                legacy_details: base_content.as_ref().and_then(|b| b.legacy_details.clone()),
                initial_inclusions: draft.inclusions.clone(),
                initial_exclusions: draft.exclusions.clone(),
                draft: Some(draft),
                raw_json: serde_json::from_str(&data)?,
            });
        }

        self.load_base_review(id, engine)
    }

    fn load_base_review(
        &self,
        id: &str,
        engine: Option<&SnomedEngine>,
    ) -> Result<ReviewFileContent, Box<dyn std::error::Error>> {
        let candidate_filename = if id.ends_with("_review") {
            format!("{}.json", id)
        } else {
            format!("{}_review.json", id)
        };
        let base_path = self.inputs_dir.join(candidate_filename);
        let data = fs::read_to_string(&base_path)?;
        let raw_json: serde_json::Value = serde_json::from_str(&data)?;

        let target_refset = raw_json.get("target_refset").and_then(|v| v.as_str()).unwrap_or(id).to_string();
        let snomed_release = raw_json.get("snomed_release").and_then(|v| v.as_str()).unwrap_or("GB Edition").to_string();
        let markdown_report = raw_json.get("markdown_report").and_then(|v| v.as_str()).map(|s| s.to_string());
        let recommendations = raw_json.get("recommendations").and_then(|v| v.as_str()).map(|s| s.to_string());

        // Extract initial inclusions & exclusions
        let mut initial_inclusions = Vec::new();
        if let Some(inc_list) = raw_json.pointer("/results/inclusion_criteria").and_then(|v| v.as_array()) {
            for item in inc_list {
                if let Some(crit_str) = item.as_str() {
                    if let Some(crit) = parse_ecl_simple_criterion(crit_str) {
                        initial_inclusions.push(crit);
                    }
                }
            }
        }

        let mut initial_exclusions = Vec::new();
        if let Some(exc_list) = raw_json.pointer("/results/exclusion_criteria").and_then(|v| v.as_array()) {
            for item in exc_list {
                if let Some(crit_str) = item.as_str() {
                    let cleaned = crit_str.trim().trim_start_matches("MINUS").trim();
                    if let Some(crit) = parse_ecl_simple_criterion(cleaned) {
                        initial_exclusions.push(crit);
                    }
                }
            }
        }

        // Target active codes resolution:
        // Priority 1: From legacy refset CSV if available
        // Priority 2: Reconstruct mathematically: (Positives \ FP) U FN
        let (active_target_codes, legacy_details) = if let Some((active, inactive)) = self.load_legacy_refset_codes(&target_refset, engine) {
            let details = LegacyRefsetDetails {
                total_count: active.len() + inactive.len(),
                active_count: active.len(),
                inactive_count: inactive.len(),
                inactive_codes: inactive.into_iter().map(|c| c.to_string()).collect(),
            };
            (active, Some(details))
        } else {
            // Reconstruct dynamically from engine + JSON
            let mut target_codes: HashSet<u64> = HashSet::new();

            if let Some(eng) = engine {
                let positives = eng.resolve_positives(&initial_inclusions, &initial_exclusions);

                // Collect False Positives from JSON
                let mut fp_set: HashSet<u64> = HashSet::new();
                if let Some(fp_list) = raw_json.pointer("/results/false_positives").and_then(|v| v.as_array()) {
                    for item in fp_list {
                        if let Some(id_str) = item.get("id").and_then(|v| v.as_str()) {
                            if let Ok(id) = id_str.trim().parse::<u64>() {
                                fp_set.insert(id);
                            }
                        }
                    }
                }

                // True Positives = Positives \ FP
                for code in positives {
                    if !fp_set.contains(&code) {
                        target_codes.insert(code);
                    }
                }
            }

            // Union with False Negatives from JSON
            if let Some(fn_list) = raw_json.pointer("/results/false_negatives").and_then(|v| v.as_array()) {
                for item in fn_list {
                    if let Some(id_str) = item.get("id").and_then(|v| v.as_str()) {
                        if let Ok(id) = id_str.trim().parse::<u64>() {
                            target_codes.insert(id);
                        }
                    }
                }
            }

            (target_codes, None)
        };

        let mut target_vec: Vec<String> = active_target_codes.into_iter().map(|c| c.to_string()).collect();
        target_vec.sort();

        Ok(ReviewFileContent {
            id: target_refset.clone(),
            is_draft: false,
            target_refset,
            snomed_release,
            markdown_report,
            recommendations,
            target_codes: target_vec,
            legacy_details,
            initial_inclusions,
            initial_exclusions,
            draft: None,
            raw_json,
        })
    }

    /// Save a draft
    pub fn save_draft(&self, draft: SavedDraft) -> Result<String, Box<dyn std::error::Error>> {
        let filename = format!("{}.json", draft.draft_id.trim());
        let path = self.storage_dir.join(&filename);
        let json_str = serde_json::to_string_pretty(&draft)?;
        fs::write(&path, json_str)?;
        Ok(draft.draft_id)
    }

    /// Check if a draft exists
    pub fn draft_exists(&self, draft_id: &str) -> bool {
        let filename = format!("{}.json", draft_id.trim());
        self.storage_dir.join(&filename).exists()
    }

    /// Delete a draft
    pub fn delete_draft(&self, draft_id: &str) -> Result<(), Box<dyn std::error::Error>> {
        let filename = format!("{}.json", draft_id.trim());
        let path = self.storage_dir.join(&filename);
        if path.exists() {
            fs::remove_file(&path)?;
            Ok(())
        } else {
            Err(format!("Draft {} not found", draft_id).into())
        }
    }
}

fn parse_ecl_simple_criterion(text: &str) -> Option<CriterionSpec> {
    let text = text.trim();
    let include_self = text.starts_with("<<");
    let rest = if include_self {
        text.strip_prefix("<<")?
    } else if text.starts_with("<") {
        text.strip_prefix("<")?
    } else {
        text
    }.trim();

    let parts: Vec<&str> = rest.split('|').collect();
    let code_str = parts[0].trim();
    let code: u64 = code_str.parse().ok()?;
    let term = parts.get(1).map(|t| t.trim().to_string());

    Some(CriterionSpec {
        concept_id: code,
        term,
        include_self,
        attributes: Vec::new(),
    })
}
