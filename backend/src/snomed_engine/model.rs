use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, BufWriter};
use std::path::Path;

pub const IS_A_RELATIONSHIP: u64 = 116680003;
pub const FSN_TYPE_ID: u64 = 900000000000003001;
pub const SYNONYM_TYPE_ID: u64 = 900000000000013009;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnomedEngine {
    /// concept_id -> list of child concept_ids (reverse Is-A)
    pub children: HashMap<u64, Vec<u64>>,
    /// concept_id -> list of parent concept_ids (forward Is-A)
    pub parents: HashMap<u64, Vec<u64>>,
    /// concept_id -> list of (type_id, destination_id)
    pub attributes: HashMap<u64, Vec<(u64, u64)>>,
    /// concept_id -> human-readable Preferred Term or FSN
    pub terms: HashMap<u64, String>,
}

impl SnomedEngine {
    pub fn new() -> Self {
        Self {
            children: HashMap::new(),
            parents: HashMap::new(),
            attributes: HashMap::new(),
            terms: HashMap::new(),
        }
    }

    /// Load SnomedEngine from pre-built binary
    pub fn from_binary_file<P: AsRef<Path>>(path: P) -> Result<Self, Box<dyn std::error::Error>> {
        let file = File::open(path)?;
        let reader = BufReader::new(file);
        let engine: SnomedEngine = bincode::deserialize_from(reader)?;
        Ok(engine)
    }

    /// Save SnomedEngine to binary file
    pub fn save_binary_file<P: AsRef<Path>>(&self, path: P) -> Result<(), Box<dyn std::error::Error>> {
        let file = File::create(path)?;
        let writer = BufWriter::new(file);
        bincode::serialize_into(writer, self)?;
        Ok(())
    }

    /// Build SnomedEngine by reading an RF2 release .zip archive
    pub fn from_rf2_zip<P: AsRef<Path>>(zip_path: P) -> Result<Self, Box<dyn std::error::Error>> {
        let file = File::open(zip_path)?;
        let mut archive = zip::ZipArchive::new(BufReader::new(file))?;

        let mut concept_idx = None;
        let mut desc_idx = None;
        let mut rel_idx = None;

        for i in 0..archive.len() {
            let name = archive.by_index(i)?.name().to_string();
            if name.contains("Snapshot/Terminology/") || name.contains("Snapshot/Terminology\\") {
                if name.contains("sct2_Concept_") && name.ends_with(".txt") {
                    concept_idx = Some(i);
                } else if name.contains("sct2_Description_") && name.ends_with(".txt") {
                    desc_idx = Some(i);
                } else if name.contains("sct2_Relationship_") && !name.contains("Stated") && !name.contains("Concrete") && name.ends_with(".txt") {
                    rel_idx = Some(i);
                }
            }
        }

        let concept_idx = concept_idx.ok_or("Concept snapshot file not found in zip")?;
        let desc_idx = desc_idx.ok_or("Description snapshot file not found in zip")?;
        let rel_idx = rel_idx.ok_or("Relationship snapshot file not found in zip")?;

        let mut active_concepts: HashSet<u64> = HashSet::new();
        {
            let zip_file = archive.by_index(concept_idx)?;
            let mut rdr = csv::ReaderBuilder::new().delimiter(b'\t').from_reader(zip_file);
            for result in rdr.records() {
                let record = result?;
                if record.get(2).map(|s| s.trim()) == Some("1") {
                    if let Some(id_str) = record.get(0) {
                        if let Ok(id) = id_str.trim().parse::<u64>() {
                            active_concepts.insert(id);
                        }
                    }
                }
            }
        }

        let mut terms: HashMap<u64, String> = HashMap::new();
        {
            let zip_file = archive.by_index(desc_idx)?;
            let mut rdr = csv::ReaderBuilder::new().delimiter(b'\t').from_reader(zip_file);
            for result in rdr.records() {
                let record = result?;
                if record.get(2).map(|s| s.trim()) == Some("1") {
                    if let (Some(cid_str), Some(type_id_str), Some(term)) = (record.get(4), record.get(6), record.get(7)) {
                        if let (Ok(concept_id), Ok(type_id)) = (cid_str.trim().parse::<u64>(), type_id_str.trim().parse::<u64>()) {
                            if active_concepts.contains(&concept_id) {
                                // Prefer FSN (type 900000000000003001), or set synonym if not already present
                                if type_id == FSN_TYPE_ID || !terms.contains_key(&concept_id) {
                                    terms.insert(concept_id, term.trim().to_string());
                                }
                            }
                        }
                    }
                }
            }
        }

        let mut children: HashMap<u64, Vec<u64>> = HashMap::new();
        let mut parents: HashMap<u64, Vec<u64>> = HashMap::new();
        let mut attributes: HashMap<u64, Vec<(u64, u64)>> = HashMap::new();

        {
            let zip_file = archive.by_index(rel_idx)?;
            let mut rdr = csv::ReaderBuilder::new().delimiter(b'\t').from_reader(zip_file);
            for result in rdr.records() {
                let record = result?;
                if record.get(2).map(|s| s.trim()) == Some("1") {
                    if let (Some(src_str), Some(dst_str), Some(type_str)) = (record.get(4), record.get(5), record.get(7)) {
                        if let (Ok(source), Ok(destination), Ok(type_id)) = (
                            src_str.trim().parse::<u64>(),
                            dst_str.trim().parse::<u64>(),
                            type_str.trim().parse::<u64>(),
                        ) {
                            if active_concepts.contains(&source) && active_concepts.contains(&destination) {
                                if type_id == IS_A_RELATIONSHIP {
                                    children.entry(destination).or_default().push(source);
                                    parents.entry(source).or_default().push(destination);
                                } else {
                                    attributes.entry(source).or_default().push((type_id, destination));
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok(Self {
            children,
            parents,
            attributes,
            terms,
        })
    }

    /// Retrieve human term
    pub fn get_term(&self, concept_id: u64) -> String {
        self.terms.get(&concept_id).cloned().unwrap_or_else(|| concept_id.to_string())
    }

    /// Fast descendant traversal (< root or << root)
    pub fn get_descendants(&self, root: u64, include_self: bool) -> HashSet<u64> {
        let mut descendants = HashSet::new();
        let mut stack = vec![root];

        while let Some(current) = stack.pop() {
            if let Some(kids) = self.children.get(&current) {
                for &child in kids {
                    if descendants.insert(child) {
                        stack.push(child);
                    }
                }
            }
        }

        if include_self {
            descendants.insert(root);
        }

        descendants
    }
}
