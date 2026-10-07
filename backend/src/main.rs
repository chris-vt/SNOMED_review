use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use snomed_review_backend::reviews::{ReviewFileContent, ReviewStore, ReviewSummaryItem, SavedDraft};
use snomed_review_backend::snomed_engine::{
    AttributeFacet, CriterionSpec, EvaluationResult, SnomedEngine,
};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

struct AppState {
    engine: Arc<SnomedEngine>,
    review_store: Arc<ReviewStore>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let binary_path = PathBuf::from("snomed_data/snomed.bin");
    let engine = if binary_path.exists() {
        tracing::info!("Loading pre-compiled SNOMED engine from {:?}", binary_path);
        SnomedEngine::from_binary_file(&binary_path)?
    } else {
        tracing::warn!("No snomed.bin found. Initializing empty engine.");
        SnomedEngine::new()
    };

    let review_store = ReviewStore::new("inputs", "storage")
        .with_legacy_csv("snomed_data/legacy_refsets.csv");

    let state = Arc::new(AppState {
        engine: Arc::new(engine),
        review_store: Arc::new(review_store),
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/reviews", get(list_reviews_handler))
        .route("/api/reviews/:id", get(get_review_handler))
        .route("/api/reviews/draft/:id", axum::routing::delete(delete_draft_handler))
        .route("/api/reviews/save", post(save_draft_handler))
        .route("/api/reviews/evaluate", post(evaluate_criteria_handler))
        .route("/api/snomed/search", get(search_concepts_handler))
        .route("/api/snomed/concept/:id", get(get_concept_handler))
        .route("/api/snomed/descendants/:id", get(get_descendants_handler))
        .route("/api/snomed/attributes/introspect", get(introspect_attributes_handler))
        .route("/api/snomed/preview", post(preview_filtered_codes_handler))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let port = 3001;
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await?;
    tracing::info!("SNOMED Review backend server listening on port {}", port);
    axum::serve(listener, app).await?;

    Ok(())
}

async fn list_reviews_handler(State(state): State<Arc<AppState>>) -> Json<Vec<ReviewSummaryItem>> {
    Json(state.review_store.list_reviews())
}

async fn get_review_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<ReviewFileContent>, StatusCode> {
    match state.review_store.load_review(&id, Some(&state.engine)) {
        Ok(review) => Ok(Json(review)),
        Err(e) => {
            tracing::error!("Error loading review {}: {}", id, e);
            Err(StatusCode::NOT_FOUND)
        }
    }
}

#[derive(Deserialize)]
struct SaveDraftRequest {
    draft: SavedDraft,
}

#[derive(Serialize)]
struct SaveDraftResponse {
    draft_id: String,
    message: String,
}

async fn save_draft_handler(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SaveDraftRequest>,
) -> Result<Json<SaveDraftResponse>, (StatusCode, String)> {
    match state.review_store.save_draft(payload.draft) {
        Ok(id) => Ok(Json(SaveDraftResponse {
            draft_id: id,
            message: "Draft saved successfully".into(),
        })),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

async fn delete_draft_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    match state.review_store.delete_draft(&id) {
        Ok(_) => Ok(Json(serde_json::json!({
            "success": true,
            "message": format!("Draft {} deleted successfully", id)
        }))),
        Err(e) => Err((StatusCode::NOT_FOUND, e.to_string())),
    }
}

#[derive(Deserialize)]
struct EvaluateRequest {
    target_refset: String,
    inclusions: Vec<CriterionSpec>,
    exclusions: Vec<CriterionSpec>,
}

async fn evaluate_criteria_handler(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<EvaluateRequest>,
) -> Result<Json<EvaluationResult>, (StatusCode, String)> {
    let review_content = state
        .review_store
        .load_review(&payload.target_refset, Some(&state.engine))
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Target refset not found: {}", e)))?;

    let target_codes_set: HashSet<u64> = review_content
        .target_codes
        .iter()
        .filter_map(|s| s.parse().ok())
        .collect();

    let result = state
        .engine
        .evaluate_criteria(&payload.inclusions, &payload.exclusions, &target_codes_set);

    Ok(Json(result))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    _domain: Option<String>,
    limit: Option<usize>,
}

#[derive(Serialize)]
struct ConceptSearchResult {
    id: String,
    term: String,
    descendant_count: usize,
}

async fn search_concepts_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SearchQuery>,
) -> Json<Vec<ConceptSearchResult>> {
    let q = query.q.trim().to_lowercase();
    let limit = query.limit.unwrap_or(30);

    let mut results = Vec::new();
    if q.is_empty() {
        return Json(results);
    }

    if let Ok(id) = q.parse::<u64>() {
        if state.engine.terms.contains_key(&id) || state.engine.children.contains_key(&id) {
            let desc_cnt = state.engine.get_descendants(id, false).len();
            results.push(ConceptSearchResult {
                id: id.to_string(),
                term: state.engine.get_term(id),
                descendant_count: desc_cnt,
            });
        }
    }

    for (&id, term) in &state.engine.terms {
        if results.len() >= limit {
            break;
        }
        if term.to_lowercase().contains(&q) {
            let id_str = id.to_string();
            if !results.iter().any(|r| r.id == id_str) {
                let desc_cnt = state.engine.get_descendants(id, false).len();
                results.push(ConceptSearchResult {
                    id: id_str,
                    term: term.clone(),
                    descendant_count: desc_cnt,
                });
            }
        }
    }

    results.sort_by(|a, b| a.term.cmp(&b.term));

    Json(results)
}

#[derive(Serialize)]
struct ConceptDetailsResponse {
    id: String,
    term: String,
    parents: Vec<ConceptSearchResult>,
    children: Vec<ConceptSearchResult>,
    descendants_count: usize,
}

async fn get_concept_handler(
    State(state): State<Arc<AppState>>,
    Path(id_str): Path<String>,
) -> Result<Json<ConceptDetailsResponse>, StatusCode> {
    let id: u64 = id_str.parse().map_err(|_| StatusCode::BAD_REQUEST)?;

    let term = state.engine.get_term(id);
    let desc_cnt = state.engine.get_descendants(id, false).len();

    let parents = state
        .engine
        .parents
        .get(&id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|pid| ConceptSearchResult {
            id: pid.to_string(),
            term: state.engine.get_term(pid),
            descendant_count: state.engine.get_descendants(pid, false).len(),
        })
        .collect();

    let children = state
        .engine
        .children
        .get(&id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|cid| ConceptSearchResult {
            id: cid.to_string(),
            term: state.engine.get_term(cid),
            descendant_count: state.engine.get_descendants(cid, false).len(),
        })
        .collect();

    Ok(Json(ConceptDetailsResponse {
        id: id_str,
        term,
        parents,
        children,
        descendants_count: desc_cnt,
    }))
}

async fn get_descendants_handler(
    State(state): State<Arc<AppState>>,
    Path(id_str): Path<String>,
) -> Result<Json<Vec<ConceptSearchResult>>, StatusCode> {
    let id: u64 = id_str.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    let descendants = state.engine.get_descendants(id, false);

    let mut results: Vec<ConceptSearchResult> = descendants
        .into_iter()
        .map(|did| ConceptSearchResult {
            id: did.to_string(),
            term: state.engine.get_term(did),
            descendant_count: 0,
        })
        .collect();

    results.sort_by(|a, b| a.term.cmp(&b.term));
    Ok(Json(results))
}

#[derive(Deserialize)]
struct IntrospectQuery {
    concept_id: u64,
    include_self: Option<bool>,
}

async fn introspect_attributes_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<IntrospectQuery>,
) -> Json<Vec<AttributeFacet>> {
    let facets = state
        .engine
        .introspect_attributes(query.concept_id, query.include_self.unwrap_or(true));
    Json(facets)
}

#[derive(Deserialize)]
struct PreviewRequest {
    concept_id: u64,
    include_self: Option<bool>,
    attributes: Vec<snomed_review_backend::snomed_engine::AttributeFilterSpec>,
}

#[derive(Serialize)]
struct PreviewResponse {
    total_count: usize,
    codes: Vec<ConceptSearchResult>,
}

async fn preview_filtered_codes_handler(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<PreviewRequest>,
) -> Json<PreviewResponse> {
    let crit = CriterionSpec {
        concept_id: payload.concept_id,
        term: None,
        include_self: payload.include_self.unwrap_or(true),
        attributes: payload.attributes,
    };

    let matched = state.engine.resolve_criterion(&crit);
    let total_count = matched.len();

    let mut codes: Vec<ConceptSearchResult> = matched
        .into_iter()
        .map(|id| ConceptSearchResult {
            id: id.to_string(),
            term: state.engine.get_term(id),
            descendant_count: 0,
        })
        .collect();

    codes.sort_by(|a, b| a.term.cmp(&b.term));

    Json(PreviewResponse {
        total_count,
        codes,
    })
}

