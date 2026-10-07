use clap::Parser;
use snomed_review_backend::snomed_engine::SnomedEngine;
use std::path::PathBuf;
use std::time::Instant;

#[derive(Parser, Debug)]
#[command(author, version, about = "Builds pre-compiled SNOMED CT binary from RF2 zip archive")]
struct Args {
    /// Path to input SNOMED RF2 .zip archive
    #[arg(short, long, default_value = "snomed_releases/uk_sct2mo_monolith.zip")]
    input: PathBuf,

    /// Path to output binary file
    #[arg(short, long, default_value = "snomed_data/snomed.bin")]
    output: PathBuf,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    println!("Starting SNOMED DB compilation from: {:?}", args.input);
    let start = Instant::now();

    let engine = SnomedEngine::from_rf2_zip(&args.input)?;
    println!(
        "Parsed in {:?}: {} concepts with terms, {} parent nodes, {} children nodes, {} concepts with attributes",
        start.elapsed(),
        engine.terms.len(),
        engine.parents.len(),
        engine.children.len(),
        engine.attributes.len()
    );

    if let Some(parent) = args.output.parent() {
        std::fs::create_dir_all(parent)?;
    }

    println!("Serializing to binary format: {:?}", args.output);
    let save_start = Instant::now();
    engine.save_binary_file(&args.output)?;
    println!("Saved successfully in {:?}", save_start.elapsed());
    println!("Total build time: {:?}", start.elapsed());

    Ok(())
}
