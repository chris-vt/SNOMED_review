use snomed_review_backend::snomed_engine::{
    CriterionSpec, SnomedEngine, FSN_TYPE_ID, IS_A_RELATIONSHIP,
};
use std::collections::{HashSet};
use std::io::Write;
use tempfile::NamedTempFile;
use zip::write::SimpleFileOptions;

/// Create a minimal synthetic RF2 zip file to verify parsing logic
fn create_synthetic_rf2_zip() -> NamedTempFile {
    let temp = NamedTempFile::new().unwrap();
    let mut zip = zip::ZipWriter::new(temp.reopen().unwrap());
    let options = SimpleFileOptions::default();

    // 1. Concept snapshot
    zip.start_file(
        "SnomedCT_Monolith/Snapshot/Terminology/sct2_Concept_Snapshot.txt",
        options,
    )
    .unwrap();
    writeln!(zip, "id\teffectiveTime\tactive\tmoduleId\tdefinitionStatusId").unwrap();
    writeln!(zip, "100\t20260101\t1\t0\t0").unwrap(); // Root Disease
    writeln!(zip, "200\t20260101\t1\t0\t0").unwrap(); // Respiratory Disease
    writeln!(zip, "300\t20260101\t1\t0\t0").unwrap(); // Asthma
    writeln!(zip, "400\t20260101\t1\t0\t0").unwrap(); // Allergic Asthma
    writeln!(zip, "500\t20260101\t1\t0\t0").unwrap(); // Lung Structure
    writeln!(zip, "999\t20260101\t0\t0\t0").unwrap(); // Inactive concept

    // 2. Description snapshot
    zip.start_file(
        "SnomedCT_Monolith/Snapshot/Terminology/sct2_Description_Snapshot.txt",
        options,
    )
    .unwrap();
    writeln!(
        zip,
        "id\teffectiveTime\tactive\tmoduleId\tconceptId\tlanguageCode\ttypeId\tterm\tcaseSignificanceId"
    )
    .unwrap();
    writeln!(zip, "1\t20260101\t1\t0\t100\ten\t{}\tDisease (disorder)\t0", FSN_TYPE_ID).unwrap();
    writeln!(zip, "2\t20260101\t1\t0\t200\ten\t{}\tRespiratory Disease (disorder)\t0", FSN_TYPE_ID).unwrap();
    writeln!(zip, "3\t20260101\t1\t0\t300\ten\t{}\tAsthma (disorder)\t0", FSN_TYPE_ID).unwrap();
    writeln!(zip, "4\t20260101\t1\t0\t400\ten\t{}\tAllergic Asthma (disorder)\t0", FSN_TYPE_ID).unwrap();
    writeln!(zip, "5\t20260101\t1\t0\t500\ten\t{}\tLung structure (body structure)\t0", FSN_TYPE_ID).unwrap();

    // 3. Relationship snapshot
    zip.start_file(
        "SnomedCT_Monolith/Snapshot/Terminology/sct2_Relationship_Snapshot.txt",
        options,
    )
    .unwrap();
    writeln!(
        zip,
        "id\teffectiveTime\tactive\tmoduleId\tsourceId\tdestinationId\trelationshipGroup\ttypeId\tcharacteristicTypeId\tmodifierId"
    )
    .unwrap();
    // 200 Is-A 100
    writeln!(zip, "10\t20260101\t1\t0\t200\t100\t0\t{}\t0\t0", IS_A_RELATIONSHIP).unwrap();
    // 300 Is-A 200
    writeln!(zip, "11\t20260101\t1\t0\t300\t200\t0\t{}\t0\t0", IS_A_RELATIONSHIP).unwrap();
    // 400 Is-A 300
    writeln!(zip, "12\t20260101\t1\t0\t400\t300\t0\t{}\t0\t0", IS_A_RELATIONSHIP).unwrap();
    // Attribute: 400 has Finding Site (363698007) -> 500 (Lung Structure)
    writeln!(zip, "13\t20260101\t1\t0\t400\t500\t0\t363698007\t0\t0").unwrap();

    zip.finish().unwrap();
    temp
}

#[test]
fn test_snomed_engine_loading_from_zip() {
    let zip_file = create_synthetic_rf2_zip();
    let engine = SnomedEngine::from_rf2_zip(zip_file.path()).expect("Should parse zip successfully");

    // Check active concepts loaded
    assert_eq!(engine.terms.get(&300).unwrap(), "Asthma (disorder)");
    assert_eq!(engine.terms.get(&400).unwrap(), "Allergic Asthma (disorder)");
    // Inactive concept 999 should not exist
    assert!(!engine.terms.contains_key(&999));

    // Check hierarchy
    let descendants_of_disease = engine.get_descendants(100, false);
    assert!(descendants_of_disease.contains(&200));
    assert!(descendants_of_disease.contains(&300));
    assert!(descendants_of_disease.contains(&400));
    assert_eq!(descendants_of_disease.len(), 3);

    let descendants_of_asthma = engine.get_descendants(300, false);
    assert_eq!(descendants_of_asthma, [400].into_iter().collect());

    // Check attribute introspection
    let facets = engine.introspect_attributes(300, true);
    assert_eq!(facets.len(), 1);
    assert_eq!(facets[0].attribute_id, 363698007);
    assert_eq!(facets[0].options[0].value_id, 500);
    assert_eq!(facets[0].options[0].count, 1);
}

#[test]
fn test_bincode_roundtrip_persistence() {
    let zip_file = create_synthetic_rf2_zip();
    let engine = SnomedEngine::from_rf2_zip(zip_file.path()).unwrap();

    let temp_bin = NamedTempFile::new().unwrap();
    engine.save_binary_file(temp_bin.path()).expect("Should save bincode");

    let loaded = SnomedEngine::from_binary_file(temp_bin.path()).expect("Should load bincode");
    assert_eq!(loaded.terms.len(), engine.terms.len());
    assert_eq!(loaded.children.len(), engine.children.len());
    assert_eq!(loaded.get_term(300), "Asthma (disorder)");
}

#[test]
fn test_criteria_evaluation_math() {
    let zip_file = create_synthetic_rf2_zip();
    let engine = SnomedEngine::from_rf2_zip(zip_file.path()).unwrap();

    // Target refset has codes: 300, 400
    let target_codes: HashSet<u64> = [300, 400].into_iter().collect();

    // Inclusion criterion: < 200 (captures 300 and 400)
    let inclusions = vec![CriterionSpec {
        concept_id: 200,
        term: Some("Respiratory Disease".into()),
        include_self: false,
        attributes: vec![],
    }];
    let exclusions = vec![];

    let result = engine.evaluate_criteria(&inclusions, &exclusions, &target_codes);
    assert_eq!(result.metrics.coverage, 1.0);
    assert_eq!(result.metrics.purity, 1.0);
    assert_eq!(result.metrics.true_positives_count, 2);
    assert_eq!(result.metrics.false_positives_count, 0);
    assert_eq!(result.metrics.false_negatives_count, 0);
}
