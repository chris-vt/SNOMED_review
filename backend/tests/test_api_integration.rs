use snomed_review_backend::reviews::{ReviewStore, SavedDraft};
use snomed_review_backend::snomed_engine::SnomedEngine;
use std::collections::HashSet;
use std::path::PathBuf;

#[test]
fn test_real_snomed_bin_loaded() {
    let bin_path = PathBuf::from("../snomed_data/snomed.bin");
    if !bin_path.exists() {
        eprintln!("Skipping test: snomed_data/snomed.bin does not exist yet.");
        return;
    }

    let engine = SnomedEngine::from_binary_file(&bin_path)
        .expect("Should deserialize generated snomed.bin successfully");

    println!("Loaded engine with {} concepts", engine.terms.len());
    assert!(engine.terms.len() > 300_000, "Should have loaded > 300,000 active concepts");

    let asthma_term = engine.get_term(195967001);
    println!("Asthma term: {}", asthma_term);
    assert!(asthma_term.to_lowercase().contains("asthma"));

    let descendants = engine.get_descendants(195967001, false);
    println!("Descendants of Asthma (195967001): {}", descendants.len());
    assert!(descendants.len() >= 50, "Asthma should have substantial descendants");

    let facets = engine.introspect_attributes(195967001, true);
    println!("Attribute facets for Asthma: {}", facets.len());
    assert!(!facets.is_empty(), "Asthma should have clinical attributes");
}

#[test]
fn test_review_store_loading_and_evaluation() {
    let bin_path = PathBuf::from("../snomed_data/snomed.bin");
    let inputs_dir = PathBuf::from("../inputs");
    let storage_dir = PathBuf::from("../storage");
    let legacy_csv_path = PathBuf::from("../snomed_data/legacy_refsets.csv");

    if !bin_path.exists() || !inputs_dir.exists() {
        eprintln!("Skipping test: required directories/files not present.");
        return;
    }

    let engine = SnomedEngine::from_binary_file(&bin_path).expect("Load snomed.bin");
    let store = ReviewStore::new(&inputs_dir, &storage_dir)
        .with_legacy_csv(&legacy_csv_path);

    // 1. List reviews
    let reviews = store.list_reviews();
    println!("Found {} reviews in store", reviews.len());
    assert!(reviews.iter().any(|r| r.target_refset == "AST_COD"));

    // 2. Load AST_COD
    let ast_review = store.load_review("AST_COD", Some(&engine)).expect("Should load AST_COD");
    assert_eq!(ast_review.target_refset, "AST_COD");
    println!("AST_COD active target codes count: {}", ast_review.target_codes.len());

    // 3. Verify legacy CSV parsing against SNOMED active engine
    let legacy_details = ast_review.legacy_details.as_ref().expect("Legacy details from CSV");
    println!("Legacy Refset Total: {}", legacy_details.total_count);
    println!("Legacy Inactive (not in SNOMED release): {}", legacy_details.inactive_count);
    println!("Legacy Active (in SNOMED release): {}", legacy_details.active_count);

    assert_eq!(legacy_details.total_count, 142, "Original AST_COD size is 142");
    assert_eq!(legacy_details.inactive_count, 12, "Exactly 12 codes are inactive");
    assert_eq!(legacy_details.active_count, 130, "Active target codes analysed must be 130");
    assert_eq!(ast_review.target_codes.len(), 130);

    // 4. Initial inclusions & exclusions from agent review
    println!("Initial inclusions count: {}", ast_review.initial_inclusions.len());
    println!("Initial exclusions count: {}", ast_review.initial_exclusions.len());
    assert_eq!(ast_review.initial_inclusions.len(), 4);
    assert_eq!(ast_review.initial_exclusions.len(), 1);

    // All initial inclusions must be standard ECL subsumption (include_self = true)
    for inc in &ast_review.initial_inclusions {
        assert!(inc.include_self, "Initial inclusions must be standard ECL subsumption <<");
    }

    // 5. Evaluate criteria using SnomedEngine
    let target_codes_set: HashSet<u64> = ast_review
        .target_codes
        .iter()
        .filter_map(|s| s.parse().ok())
        .collect();

    let eval_result = engine.evaluate_criteria(
        &ast_review.initial_inclusions,
        &ast_review.initial_exclusions,
        &target_codes_set,
    );

    println!("Evaluated AST_COD criteria under standard ECL:");
    println!("  Coverage: {:.1}%", eval_result.metrics.coverage * 100.0);
    println!("  Purity: {:.1}%", eval_result.metrics.purity * 100.0);
    println!("  Positives: {}", eval_result.metrics.positives_count);
    println!("  True Positives (TP): {}", eval_result.metrics.true_positives_count);
    println!("  False Positives (FP): {}", eval_result.metrics.false_positives_count);
    println!("  False Negatives (FN): {}", eval_result.metrics.false_negatives_count);

    // 6. Assert exact mathematical invariants:
    // (Positives \ FP) U FN == Target Codes
    let positives_ids: HashSet<u64> = eval_result.positives.iter().filter_map(|i| i.id.parse().ok()).collect();
    let fp_ids: HashSet<u64> = eval_result.false_positives.iter().filter_map(|i| i.id.parse().ok()).collect();
    let fn_ids: HashSet<u64> = eval_result.false_negatives.iter().filter_map(|i| i.id.parse().ok()).collect();

    let mut reconstructed_target: HashSet<u64> = positives_ids
        .into_iter()
        .filter(|id| !fp_ids.contains(id))
        .collect();
    reconstructed_target.extend(fn_ids);

    assert_eq!(reconstructed_target, target_codes_set, "Mathematical invariant must strictly hold: (Positives \\ FP) U FN == Target Codes");

    // Exact metrics match
    assert_eq!(eval_result.metrics.true_positives_count, 128);
    assert_eq!(eval_result.metrics.false_positives_count, 22);
    assert_eq!(eval_result.metrics.false_negatives_count, 2);
    assert!((eval_result.metrics.coverage - 0.985).abs() < 0.005);
    assert!((eval_result.metrics.purity - 0.853).abs() < 0.005);

    // 7. Test saving and retrieving a draft
    let draft = SavedDraft {
        draft_id: "AST_COD_Joe_v1".into(),
        target_refset: "AST_COD".into(),
        snomed_release: "GB Edition".into(),
        reviewer: "Dr Joe".into(),
        updated_at: "2026-10-07".into(),
        notes: "Initial review draft".into(),
        inclusions: ast_review.initial_inclusions.clone(),
        exclusions: ast_review.initial_exclusions.clone(),
        metrics: Some(eval_result.metrics),
        generated_ecl: Some(eval_result.generated_ecl),
    };

    let saved_id = store.save_draft(draft).expect("Save draft");
    let loaded_draft_content = store.load_review(&saved_id, Some(&engine)).expect("Load draft");
    assert!(loaded_draft_content.is_draft);
    assert_eq!(loaded_draft_content.id, "AST_COD_Joe_v1");

    // Clean up test draft
    let draft_file = storage_dir.join(format!("{}.json", saved_id));
    let _ = std::fs::remove_file(draft_file);
}
