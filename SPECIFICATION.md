# Technical and Product Specification: SNOMED Review Tool

**Location:** `/home/chris/03.projects/SNOMED_review`  
**Target Deployment:** NixOS Server (Flake-based dev and build environment)  
**Date:** October 2026  

---

## 1. Executive Summary & Business Goals

### 1.1 Context
We are modernizing legacy NHS primary care static code lists (refsets) into clean, maintainable SNOMED CT **Expression Constraint Language (ECL)** criteria. 

Reverse-engineering algorithms generate candidate ECL definitions from legacy code lists. In this domain, the business objectives follow a strict hierarchy:
1. **Interpretability First:** Concise, clinically meaningful expressions that NHS governance panels can read, debate, and approve in minutes.
2. **Coverage Second:** Capturing the vast majority of relevant clinical records.
3. **Purity Negotiable:** Capturing clinically logical "False Positives" is often desirable, as it rectifies historical omissions in legacy lists.

### 1.2 Purpose of the Web Interface
The **SNOMED Review Tool** provides an interactive web workspace for human clinical advisors to:
- Review the automated agent's reverse-engineered recommendations, clinical narratives, and trade-off rationales.
- Inspect False Positives (differentiating valid omissions from noise) and False Negatives (boundary justifications).
- Interactively amend inclusion and exclusion criteria using a structured domain-builder (Doors, concept search, attribute facet introspection).
- Receive instant recalculations of Coverage, Purity, TP, FP, and FN directly from the backend.
- Save and manage versioned drafts (e.g. `MH_COD_Joe_v1`) without modifying original agent inputs.

---

## 2. System Architecture

The application is structured as a decoupled client-server architecture inside `/home/chris/03.projects/SNOMED_review`:

```
SNOMED_review/
├── flake.nix                  # Nix Flake providing Node 22, Rust toolchain, packages
├── flake.lock
├── snomed_data/               # Directory containing generated .bin terminology databases
├── storage/                   # Saved review drafts (e.g., MH_COD_Joe_v1.json)
├── inputs/                    # Local copy of agent review inputs (e.g., AST_COD_review.json)
├── backend/                   # Pure Rust backend (Axum, Tokio, Bincode)
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs            # Axum HTTP API routes & app state
│       ├── bin/
│       │   └── build_snomed_db.rs  # Ad-hoc CLI utility to parse RF2 .zip into .bin
│       ├── snomed_engine/     # In-memory graph + descriptions + attribute index
│       │   ├── mod.rs
│       │   ├── model.rs
│       │   └── evaluator.rs   # Evaluates criteria set against refset codes
│       └── reviews/           # Load original reviews & manage saved draft files
└── frontend/                  # React 19 + TypeScript + Vite + Tailwind CSS
    ├── package.json
    ├── vite.config.ts
    └── src/
        ├── App.tsx            # Main application layout
        ├── components/
        │   ├── Header.tsx     # Refset selector, Draft manager, Save action
        │   ├── LeftPanel/     # Agent Review & Real-time Impact View
        │   │   ├── MetricCards.tsx
        │   │   ├── NarrativeViewer.tsx (Markdown report & recommendations)
        │   │   ├── FalsePositivesList.tsx
        │   │   └── FalseNegativesList.tsx
        │   └── RightPanel/    # Interactive Criteria Builder
        │       ├── DoorSelector.tsx (Findings, Procedures, Situations)
        │       ├── ConceptSearch.tsx
        │       ├── AttributeFilters.tsx (Facets & counts)
        │       ├── CriteriaList.tsx (Active inclusion / exclusion rules)
        │       └── GeneratedEclViewer.tsx
        └── services/
            └── api.ts         # REST client communicating with Rust backend
```

---

## 3. Backend Engine & Terminology Database

### 3.1 Ad-Hoc DB Generator Utility (`build_snomed_db`)
- **Input:** A release `.zip` file containing SNOMED CT RF2 release files (e.g. `uk_sct2mo_monolith.zip`).
- **Processing:**
  - Extracts active concepts (`sct2_Concept_Snapshot_*.txt`).
  - Extracts preferred terms and FSN descriptions (`sct2_Description_Snapshot_*.txt`).
  - Extracts active `Is-A` (116680003) parent/child relationships (`sct2_Relationship_Snapshot_*.txt`).
  - Extracts active semantic attribute relationships (`type_id != 116680003`).
- **Output:** A single fast binary file (`snomed_engine.bin`) serialized via `bincode`.
- **Usage:** Run on-demand via `cargo run --bin build_snomed_db -- --input /path/to/release.zip --output snomed_data/snomed.bin`.

### 3.2 In-Memory Rust Engine Data Model
```rust
pub struct SnomedEngine {
    pub children: HashMap<u64, Vec<u64>>,
    pub parents: HashMap<u64, Vec<u64>>,
    pub attributes: HashMap<u64, Vec<(u64, u64)>>, // concept_id -> [(attr_type, attr_value)]
    pub terms: HashMap<u64, String>,               // concept_id -> Preferred Term / FSN
}
```

### 3.3 Backend API Endpoints

#### 1. Terminology & Hierarchy
- `GET /api/snomed/search?q={query}&domain={domain}&limit=50`: Search concepts by term or ID, optionally restricted to a top-level hierarchy branch.
- `GET /api/snomed/concept/:id`: Get concept details, term, parents, and children count.
- `GET /api/snomed/descendants/:id`: Get all descendants under an anchor concept.
- `GET /api/snomed/attributes/introspect?concept_id={id}`: Introspect all attributes present across descendant concepts under an anchor, returning attribute types, target values, and code occurrence counts.

#### 2. Review & Draft Management
- `GET /api/reviews`: List available review templates and existing saved drafts.
- `GET /api/reviews/:id`: Load an original agent review or a specific saved draft.
- `POST /api/reviews/save`: Save a draft under a given filename (e.g. `MH_COD_Joe_v1`).
- `POST /api/reviews/evaluate`: Recalculate metrics for modified criteria:
  - **Request:**
    ```json
    {
      "target_refset": "AST_COD",
      "inclusions": [
        { "id": 195967001, "attributes": [{ "type_id": 363698007, "value_ids": [20139000] }] }
      ],
      "exclusions": [
        { "id": 397579009, "attributes": [] }
      ]
    }
    ```
  - **Response:**
    - `metrics`: `{ coverage: 0.985, purity: 0.853, tp_count: 128, fp_count: 22, fn_count: 2 }`
    - `false_positives`: `[ { "id": "170631002", "term": "Asthma disturbing sleep (finding)" }, ... ]`
    - `false_negatives`: `[ { "id": "89099002", "term": "Chronic allergic bronchitis (disorder)" }, ... ]`
    - `generated_ecl`: Formatted ECL query string.

---

## 4. Frontend UX & User Interface

### 4.1 Unified Side-by-Side Dashboard Layout
The user interface maintains a single unified dashboard:

```
+-------------------------------------------------------------------------------------------------------+
|  HEADER: [ Refset: AST_COD v ]  [ Draft: AST_COD_Joe_v1 v ]  [ Save Draft ]  [ Export ECL ]           |
+---------------------------------------------------+---------------------------------------------------+
| LEFT PANEL: Review & Evaluated Impact             | RIGHT PANEL: Interactive Refset Builder           |
|                                                   |                                                   |
| 1. High-Level Metrics Summary                     | 1. Domain Doors                                   |
|    [ Coverage: 98.5% ] [ Purity: 85.3% ]          |    [ Findings ] [ Procedures ] [ Situations ]     |
|    [ TP: 128 ] [ FP: 22 ] [ FN: 2 ]               |                                                   |
|                                                   | 2. Concept Search & MGA Selector                  |
| 2. Clinical Narrative & Justifications            |    [ Search: "asthma"                 ] [Search]  |
|    - Sensitivities & Boundary Justifications      |    > 195967001 | Asthma (disorder)  (+ Add Rule)  |
|    - Trade-off Rationale                          |                                                   |
|                                                   | 3. Attribute Facet Introspector                   |
| 3. False Positives Breakdown (Interactive)        |    [v] Finding site (32 codes)                    |
|    - List with badges & clinical notes            |        [x] Respiratory system                     |
|                                                   |                                                   |
| 4. False Negatives Breakdown                      | 4. Active Criteria Stack                          |
|    - List of uncaptured legacy targets            |    Inclusions:                                    |
|                                                   |    + < 195967001 | Asthma (disorder)       [x]    |
|                                                   |    Exclusions:                                    |
|                                                   |    - < 397579009 | Asthma trigger          [x]    |
+---------------------------------------------------+---------------------------------------------------+
```

### 4.2 Left Panel: Review & Evaluated Impact
- **Agent Narrative Tab:** Renders the rich Markdown report from the agent, detailing why the algorithm selected specific anchors and why certain codes were excluded.
- **Dynamic Metrics Card:** Reflects either the original agent baseline or real-time recalculated values when criteria are modified on the right.
- **Code Explorer (FP / FN):** Clinicians can review false positives and negatives, search through them, and understand why they are captured or excluded.

### 4.3 Right Panel: Interactive Refset Builder
- Based on the proven UX from `SNOMED_refset_builder`.
- Uses domain doors: **Clinical findings**, **Procedures**, **Situations**.
- Search concepts natively against the Rust backend in real time.
- Select a root anchor concept and view all relevant clinical attributes with occurrence counts.
- Check/uncheck attribute facets to filter the anchor expression.
- Add anchor expressions as Inclusions (`< ...`) or Exclusions (`MINUS < ...`).
- Whenever criteria are modified, the backend evaluates the set and updates the left panel instantly.

### 4.4 Draft Management & File Naming
- Clinicians can save revisions using a simple file naming scheme (e.g. `AST_COD_Joe_v1`).
- Saved drafts store:
  - Base target refset.
  - Active inclusion & exclusion criteria.
  - Snapshot of calculated metrics (coverage, purity, TP, FP, FN).
  - Any reviewer notes.
- Users can reload any past saved draft or the original agent input at any time.

---

## 5. NixOS / Dev Environment Specification (`flake.nix`)

- Multi-system devShell supporting `x86_64-linux` and `aarch64-linux`.
- Packages provided:
  - `rustc`, `cargo`, `rustfmt`, `clippy`, `cargo-watch`
  - `nodejs_22`, `corepack_22`
  - `zip`, `unzip`, `pkg-config`, `openssl`
- Shell hook configured for zero-friction launch:
  - Backend: `cargo run` (or `cargo watch -x run`)
  - Frontend: `npm run dev`

---

## 6. Implementation Plan & Milestones

1. **Phase 1: Environment & Workspace Setup**
   - Initialize `/home/chris/03.projects/SNOMED_review` with `flake.nix`.
   - Setup project directories (`backend/`, `frontend/`, `inputs/`, `storage/`).
   - Copy initial review files from `/home/chris/03.projects/thunderstorm_agent/reviews` into local `inputs/`.
2. **Phase 2: SNOMED Rust Engine & DB Builder**
   - Implement `build_snomed_db` CLI binary to parse RF2 zip/files into `snomed.bin` including descriptions.
   - Implement in-memory `SnomedEngine` with descendant lookup, attribute introspection, and criteria evaluation.
   - Build and test Axum API endpoints.
3. **Phase 3: Frontend Interface Development**
   - Scaffold Vite React + Tailwind app in `frontend/`.
   - Implement unified two-panel layout: Left Panel (Review & Impact) and Right Panel (Criteria Builder).
   - Wire up domain doors, live search, attribute filters, and criteria stack.
4. **Phase 4: Real-time Evaluation & Draft Persistence**
   - Wire criteria edits to backend `/api/reviews/evaluate` for live metric updates.
   - Implement draft saving (`[RefsetName]_[Reviewer]_[Version]`) and loading.
5. **Phase 5: Validation & Verification**
   - End-to-end verification against real review dataset (e.g. `AST_COD_review.json`).
   - Ensure clean Nix build and headless deployment readiness.
