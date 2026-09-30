mod dto;

use std::{
    collections::HashSet,
    fs::{self, File},
    io::{ErrorKind, Read, Write},
    net::TcpListener,
    path::{Path as FsPath, PathBuf},
    sync::Mutex,
};
use serde_json::{Map, Value};

use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use mime_guess::from_path;
use tauri::async_runtime;
use tokio::sync::oneshot;
use tower_http::cors::CorsLayer;
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::{
    application::{AdminService, DocumentService, LibraryService},
    domain::{AppError, DbRecord, LibraryListItem},
    infrastructure::{build_variant_cbz_relative_path_from_parts, resolve_variant_cbz_path},
};
pub use dto::ApiEndpointPayload;
use dto::{
    ChapterPage, ChapterPagesResponse, DeleteResponse, ErrorResponse, FindBody, HealthResponse,
    DownloadOfflineChaptersBody, DownloadOfflineChaptersResponse,
    LibraryComicResponse, LibraryComicListResponse,
    ImportComicBody, ImportComicResponse, ListQuery, MarkChaptersBody, MarkChaptersResponse,
    MigrateLegacyBody, MigrateLegacyResponse, SaveVariantPagesBody, UpsertBody,
};

#[derive(Clone)]
struct RestState {
    service: DocumentService,
    admin_service: AdminService,
    library_service: LibraryService,
    admin_enabled: bool,
    comics_dir: PathBuf,
}

#[derive(Clone)]
struct CbzPageEntry {
    archive_index: usize,
    file_name: String,
}

#[derive(OpenApi)]
#[openapi(
    paths(
        health,
        upsert_record,
        get_record,
        list_records,
        find_records,
        delete_record,
        list_library_comics,
        get_library_comic,
        download_library_chapters_offline,
        upsert_library_variant_pages,
        list_chapter_pages,
        get_chapter_page,
        get_comic_cover,
        mark_chapters_read_state,
        import_comic,
        migrate_legacy
    ),
    components(
        schemas(
            DbRecord,
            UpsertBody,
            FindBody,
            HealthResponse,
            DeleteResponse,
            ErrorResponse,
            ChapterPage,
            ChapterPagesResponse,
            DownloadOfflineChaptersBody,
            DownloadOfflineChaptersResponse,
            LibraryListItem,
            LibraryComicResponse,
            LibraryComicListResponse,
            MarkChaptersBody,
            MarkChaptersResponse,
            ImportComicBody,
            ImportComicResponse,
            SaveVariantPagesBody,
            MigrateLegacyBody,
            MigrateLegacyResponse
        )
    ),
    tags(
        (name = "db", description = "JSON document storage API")
    )
)]
struct ApiDoc;

pub struct RestApiState {
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
    endpoint: ApiEndpointPayload,
}

impl RestApiState {
    pub fn endpoint(&self) -> ApiEndpointPayload {
        self.endpoint.clone()
    }

    pub fn stop(&self) {
        if let Ok(mut guard) = self.shutdown.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(());
            }
        }
    }
}

pub fn start_rest_api(
    service: DocumentService,
    admin_service: AdminService,
    library_service: LibraryService,
    comics_dir: PathBuf,
) -> Result<RestApiState, String> {
    let preferred_port = std::env::var("REST_API_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8787);
    let (listener, port) = bind_listener(preferred_port)?;
    let host = "127.0.0.1".to_string();
    let base_url = format!("http://{host}:{port}/api");
    let endpoint = ApiEndpointPayload {
        host,
        port,
        base_url,
    };

    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Failed to configure REST API listener: {e}"))?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let app = build_router(RestState {
        service,
        admin_service,
        library_service,
        admin_enabled: admin_endpoints_enabled(),
        comics_dir,
    });

    async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("REST API listener error: {error}");
                return;
            }
        };

        let server = axum::serve(listener, app).with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        });

        if let Err(error) = server.await {
            eprintln!("REST API server terminated with error: {error}");
        }
    });

    Ok(RestApiState {
        shutdown: Mutex::new(Some(shutdown_tx)),
        endpoint,
    })
}

fn bind_listener(preferred_port: u16) -> Result<(TcpListener, u16), String> {
    let preferred_addr = format!("127.0.0.1:{preferred_port}");
    match TcpListener::bind(&preferred_addr) {
        Ok(listener) => Ok((listener, preferred_port)),
        Err(error) if error.kind() == ErrorKind::AddrInUse => {
            let listener = TcpListener::bind("127.0.0.1:0")
                .map_err(|e| format!("Failed to bind dynamic REST API port: {e}"))?;
            let port = listener
                .local_addr()
                .map_err(|e| format!("Failed to read dynamic REST API port: {e}"))?
                .port();
            Ok((listener, port))
        }
        Err(error) => Err(format!(
            "Failed to bind REST API on preferred port {preferred_port}: {error}"
        )),
    }
}

fn build_router(state: RestState) -> Router {
    let mut router = Router::new()
        .route("/api/health", get(health))
        .route("/api/db/{table}", get(list_records).post(upsert_record))
        .route(
            "/api/db/{table}/{id}",
            get(get_record).delete(delete_record),
        )
        .route("/api/db/{table}/find", post(find_records))
        .route("/api/library", get(list_library_comics))
        .route("/api/library/{comic_id}", get(get_library_comic).delete(delete_library_comic))
        .route("/api/library/{comic_id}/offline", post(download_library_chapters_offline))
        .route(
            "/api/library/{comic_id}/chapters/{chapter_id}/variants/pages",
            post(upsert_library_variant_pages),
        )
        .route("/api/chapters/{chapter_id}/pages", get(list_chapter_pages))
        .route(
            "/api/library/{comic_id}/chapters/{chapter_id}/pages",
            get(list_library_chapter_pages),
        )
        .route(
            "/api/chapters/{chapter_id}/pages/{page_index}",
            get(get_chapter_page),
        )
        .route(
            "/api/library/{comic_id}/chapters/{chapter_id}/pages/{page_index}",
            get(get_library_chapter_page),
        )
        .route("/api/comics/{comic_id}/cover", get(get_comic_cover))
        .route("/api/chapters/mark", post(mark_chapters_read_state))
        .route("/api/import/comic", post(import_comic))
        .merge(SwaggerUi::new("/swagger").url("/api-docs/openapi.json", ApiDoc::openapi()))
        .layer(CorsLayer::permissive());

    if state.admin_enabled {
        router = router.route("/api/admin/migrate-legacy", post(migrate_legacy));
    }

    router.with_state(state)
}

#[utoipa::path(
    get,
    path = "/api/health",
    tag = "db",
    responses(
        (status = 200, description = "API health", body = HealthResponse)
    )
)]
async fn health() -> impl IntoResponse {
    Json(HealthResponse {
        status: "ok".to_string(),
    })
}

#[utoipa::path(
    post,
    path = "/api/db/{table}",
    tag = "db",
    params(
        ("table" = String, Path, description = "Table name")
    ),
    request_body = UpsertBody,
    responses(
        (status = 200, description = "Upserted record", body = DbRecord),
        (status = 400, description = "Invalid request", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse)
    )
)]
async fn upsert_record(
    State(state): State<RestState>,
    Path(table): Path<String>,
    Json(payload): Json<UpsertBody>,
) -> Result<Json<DbRecord>, (StatusCode, String)> {
    let record = state
        .service
        .upsert(&table, payload.id, payload.data)
        .map_err(internal_error)?;
    Ok(Json(record))
}

#[utoipa::path(
    get,
    path = "/api/db/{table}/{id}",
    tag = "db",
    params(
        ("table" = String, Path, description = "Table name"),
        ("id" = String, Path, description = "Record id")
    ),
    responses(
        (status = 200, description = "Record found", body = DbRecord),
        (status = 404, description = "Record not found", body = ErrorResponse),
        (status = 400, description = "Invalid request", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse)
    )
)]
async fn get_record(
    State(state): State<RestState>,
    Path((table, id)): Path<(String, String)>,
) -> Result<Json<DbRecord>, (StatusCode, String)> {
    let record = state.service.get(&table, &id).map_err(internal_error)?;

    match record {
        Some(value) => Ok(Json(value)),
        None => Err((StatusCode::NOT_FOUND, "Record not found".to_string())),
    }
}

#[utoipa::path(
    get,
    path = "/api/db/{table}",
    tag = "db",
    params(
        ("table" = String, Path, description = "Table name"),
        ("limit" = Option<u32>, Query, description = "Limit"),
        ("offset" = Option<u32>, Query, description = "Offset")
    ),
    responses(
        (status = 200, description = "Record list", body = [DbRecord]),
        (status = 400, description = "Invalid request", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse)
    )
)]
async fn list_records(
    State(state): State<RestState>,
    Path(table): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<DbRecord>>, (StatusCode, String)> {
    let values = state
        .service
        .list(&table, query.limit, query.offset)
        .map_err(internal_error)?;
    Ok(Json(values))
}

#[utoipa::path(
    post,
    path = "/api/db/{table}/find",
    tag = "db",
    params(
        ("table" = String, Path, description = "Table name")
    ),
    request_body = FindBody,
    responses(
        (status = 200, description = "Matching records", body = [DbRecord]),
        (status = 400, description = "Invalid request", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse)
    )
)]
async fn find_records(
    State(state): State<RestState>,
    Path(table): Path<String>,
    Json(payload): Json<FindBody>,
) -> Result<Json<Vec<DbRecord>>, (StatusCode, String)> {
    let values = state
        .service
        .find_by_json_field(&table, &payload.json_path, payload.value, payload.limit)
        .map_err(internal_error)?;
    Ok(Json(values))
}

#[utoipa::path(
    delete,
    path = "/api/db/{table}/{id}",
    tag = "db",
    params(
        ("table" = String, Path, description = "Table name"),
        ("id" = String, Path, description = "Record id")
    ),
    responses(
        (status = 200, description = "Delete result", body = DeleteResponse),
        (status = 400, description = "Invalid request", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse)
    )
)]
async fn delete_record(
    State(state): State<RestState>,
    Path((table, id)): Path<(String, String)>,
) -> Result<Json<DeleteResponse>, (StatusCode, String)> {
    let deleted = state.service.delete(&table, &id).map_err(internal_error)?;
    Ok(Json(DeleteResponse { deleted }))
}

#[utoipa::path(
    get,
    path = "/api/library",
    tag = "db",
    responses(
        (status = 200, description = "Library comic list", body = [LibraryListItem]),
        (status = 500, description = "Internal error", body = ErrorResponse)
    )
)]
async fn list_library_comics(
    State(state): State<RestState>,
) -> Result<Json<Vec<LibraryListItem>>, (StatusCode, String)> {
    let items = state.library_service.list_comics().map_err(internal_error)?;
    Ok(Json(items))
}

#[utoipa::path(
    get,
    path = "/api/library/{comic_id}",
    tag = "db",
    params(
        ("comic_id" = String, Path, description = "Comic id")
    ),
    responses(
        (status = 200, description = "Comic metadata", body = LibraryComicResponse),
        (status = 404, description = "Comic not found", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse)
    )
)]
async fn get_library_comic(
    State(state): State<RestState>,
    Path(comic_id): Path<String>,
) -> Result<Json<crate::domain::ComicMetadata>, (StatusCode, String)> {
    let comic = state
        .library_service
        .get_comic(&comic_id)
        .map_err(internal_error)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Comic not found".to_string()))?;
    Ok(Json(comic))
}

#[utoipa::path(
    delete,
    path = "/api/library/{comic_id}",
    tag = "db",
    params(
        ("comic_id" = String, Path, description = "Comic id")
    ),
    responses(
        (status = 200, description = "Delete result", body = DeleteResponse),
        (status = 500, description = "Internal error", body = ErrorResponse)
    )
)]
async fn delete_library_comic(
    State(state): State<RestState>,
    Path(comic_id): Path<String>,
) -> Result<Json<DeleteResponse>, (StatusCode, String)> {
    let deleted = state
        .library_service
        .delete_comic(&comic_id)
        .map_err(internal_error)?;
    Ok(Json(DeleteResponse { deleted }))
}

#[utoipa::path(
    post,
    path = "/api/library/{comic_id}/offline",
    tag = "db",
    params(
        ("comic_id" = String, Path, description = "Comic id")
    ),
    request_body = DownloadOfflineChaptersBody,
    responses(
        (status = 200, description = "Offline chapters downloaded", body = DownloadOfflineChaptersResponse),
        (status = 400, description = "Invalid request", body = ErrorResponse),
        (status = 404, description = "Comic or chapter variant not found", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse)
    )
)]
async fn download_library_chapters_offline(
    State(state): State<RestState>,
    Path(comic_id): Path<String>,
    Json(payload): Json<DownloadOfflineChaptersBody>,
) -> Result<Json<DownloadOfflineChaptersResponse>, (StatusCode, String)> {
    if payload.variant_ids.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "variantIds cannot be empty".to_string()));
    }

    let requested = payload.variant_ids.len();
    let variant_id_set = payload.variant_ids.into_iter().collect::<HashSet<_>>();
    let mut comic = state
        .library_service
        .get_comic(&comic_id)
        .map_err(internal_error)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Comic not found".to_string()))?;

    let comic_dir = state.comics_dir.join(&comic.slug);
    let comic_slug = comic.slug.clone();
    fs::create_dir_all(comic_dir.join("chapters"))
        .map_err(|error| internal_error(AppError::infrastructure(error.to_string())))?;

    let mut downloaded = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;
    let mut found_variants = HashSet::new();

    for chapter in &mut comic.chapters {
        for variant in &mut chapter.variants {
            if !variant_id_set.contains(&variant.id) {
                continue;
            }
            found_variants.insert(variant.id.clone());

            let existing_cbz = variant
                .offline
                .as_ref()
                .and_then(|entry| entry.cbz_file.as_deref())
                .map(|relative| comic_dir.join(relative))
                .filter(|path| path.is_file());
            if existing_cbz.is_some() {
                skipped += 1;
                continue;
            }

            let process_result: Result<(), AppError> = (|| {
                let pages = if !variant.pages.is_empty() {
                    variant.pages.clone()
                } else {
                    fetch_pages_for_variant(&state, variant)?
                };
                if pages.is_empty() {
                    return Err(AppError::Validation(format!(
                        "Chapter variant {} has no downloadable pages",
                        variant.id
                    )));
                }

                let relative_path = build_variant_cbz_relative_path_from_parts(
                    &comic_slug,
                    &chapter.number,
                    variant.language.as_deref(),
                    variant.plugin_tag.as_deref(),
                    variant.plugin_id.as_deref(),
                );
                let target_path = comic_dir.join(&relative_path);
                if let Some(parent) = target_path.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|error| AppError::infrastructure(error.to_string()))?;
                }

                write_chapter_cbz(&comic_dir, &target_path, &pages)?;
                let size_bytes = fs::metadata(&target_path)
                    .map_err(|error| AppError::infrastructure(error.to_string()))?
                    .len();
                variant.offline = Some(crate::domain::OfflineChapterFile {
                    available: true,
                    cbz_file: Some(relative_path),
                    page_count: Some(pages.len()),
                    size_bytes: Some(size_bytes),
                    updated_at: Some(now_unix_string()),
                });
                Ok(())
            })();

            match process_result {
                Ok(()) => {
                    downloaded += 1;
                }
                Err(error) => {
                    failed += 1;
                    eprintln!(
                        "[comic-universe] failed to download offline variant {}: {}",
                        variant.id, error
                    );
                }
            }
        }
    }

    if found_variants.len() != variant_id_set.len() {
        return Err((StatusCode::NOT_FOUND, "One or more chapter variants were not found".to_string()));
    }

    if downloaded > 0 {
        comic.updated_at = now_unix_string();
        state
            .library_service
            .save_comic(&comic)
            .map_err(internal_error)?;
    }

    Ok(Json(DownloadOfflineChaptersResponse {
        comic_id: comic.id,
        requested,
        downloaded,
        skipped,
        failed,
    }))
}

#[utoipa::path(
    post,
    path = "/api/library/{comic_id}/chapters/{chapter_id}/variants/pages",
    tag = "db",
    params(
        ("comic_id" = String, Path, description = "Comic id"),
        ("chapter_id" = String, Path, description = "Chapter id")
    ),
    request_body = SaveVariantPagesBody,
    responses(
        (status = 200, description = "Updated comic metadata", body = LibraryComicResponse),
        (status = 404, description = "Comic or chapter not found", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse)
    )
)]
async fn upsert_library_variant_pages(
    State(state): State<RestState>,
    Path((comic_id, chapter_id)): Path<(String, String)>,
    Json(payload): Json<SaveVariantPagesBody>,
) -> Result<Json<crate::domain::ComicMetadata>, (StatusCode, String)> {
    let _ = &payload.canonical_chapter_id;
    let mut comic = state
        .library_service
        .get_comic(&comic_id)
        .map_err(internal_error)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Comic not found".to_string()))?;

    let chapter = comic
        .chapters
        .iter_mut()
        .find(|entry| entry.id == chapter_id)
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Chapter not found".to_string()))?;

    if let Some(existing) = chapter
        .variants
        .iter_mut()
        .find(|variant| variant.id == payload.variant_id)
    {
        existing.plugin_id = payload.plugin_id.clone().or(existing.plugin_id.clone());
        existing.plugin_tag = payload.plugin_tag.clone().or(existing.plugin_tag.clone());
        existing.plugin_name = payload.plugin_name.clone().or(existing.plugin_name.clone());
        existing.chapter_site_id = payload.chapter_site_id.clone().or(existing.chapter_site_id.clone());
        existing.chapter_site_url = payload.chapter_site_url.clone().or(existing.chapter_site_url.clone());
        existing.language = payload.language.clone().or(existing.language.clone());
        existing.name = payload.name.clone().or(existing.name.clone());
        existing.pages = payload.pages.clone();
        existing.source_data = payload.source_data.clone();
    } else {
        chapter.variants.push(crate::domain::ChapterVariant {
            id: payload.variant_id.clone(),
            language: payload.language.clone(),
            plugin_id: payload.plugin_id.clone(),
            plugin_tag: payload.plugin_tag.clone(),
            plugin_name: payload.plugin_name.clone(),
            chapter_site_id: payload.chapter_site_id.clone(),
            chapter_site_url: payload.chapter_site_url.clone(),
            pages: payload.pages.clone(),
            offline: None,
            source_data: payload.source_data.clone(),
            name: payload.name.clone(),
        });
    }

    let mut available_languages = chapter.available_languages.clone();
    for language in payload
        .language_codes
        .iter()
        .cloned()
        .chain(payload.language.iter().cloned())
    {
        if !language.trim().is_empty() && !available_languages.iter().any(|entry| entry == &language) {
            available_languages.push(language);
        }
    }
    chapter.available_languages = available_languages;
    comic.updated_at = now_unix_string();

    state
        .library_service
        .save_comic(&comic)
        .map_err(internal_error)?;
    Ok(Json(comic))
}

#[utoipa::path(
    get,
    path = "/api/chapters/{chapter_id}/pages",
    tag = "db",
    params(
        ("chapter_id" = String, Path, description = "Chapter id")
    ),
    responses(
        (status = 200, description = "Chapter page URLs", body = ChapterPagesResponse),
        (status = 404, description = "Chapter or CBZ not found", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse)
    )
)]
async fn list_chapter_pages(
    State(state): State<RestState>,
    Path(chapter_id): Path<String>,
) -> Result<Json<ChapterPagesResponse>, (StatusCode, String)> {
    if let Some(response) = list_library_chapter_pages_by_chapter_id(&state, &chapter_id).await? {
        return Ok(Json(response));
    }

    let chapter = state
        .service
        .get("chapters", &chapter_id)
        .map_err(internal_error)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Chapter not found".to_string()))?;

    let comic_id = chapter_value_as_string(&chapter, "comicId").ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "Chapter has no comicId".to_string(),
        )
    })?;
    let chapter_name = chapter_display_name(&chapter);
    let chapter_number = chapter_value_as_string(&chapter, "number");

    let comic = state
        .service
        .get("comics", &comic_id)
        .map_err(internal_error)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Comic not found".to_string()))?;
    let comic_name = chapter_value_as_string(&comic, "name").unwrap_or_else(|| comic_id.clone());

    let cbz_path = resolve_chapter_cbz_path(
        &state.comics_dir,
        &comic_id,
        &comic_name,
        &chapter_name,
        chapter_number.as_deref(),
    );

    let pages = if let Some(cbz_path) = cbz_path {
        let entries = list_image_entries(&cbz_path).map_err(internal_error)?;
        if entries.is_empty() {
            return Err((StatusCode::NOT_FOUND, "CBZ has no image pages".to_string()));
        }

        entries
            .iter()
            .enumerate()
            .map(|(index, entry)| ChapterPage {
                index,
                file_name: entry.file_name.clone(),
                url: format!("/api/chapters/{chapter_id}/pages/{index}"),
            })
            .collect::<Vec<_>>()
    } else {
        let external_pages = chapter_external_pages(&chapter);
        if external_pages.is_empty() {
            return Err((
                StatusCode::NOT_FOUND,
                "Chapter has no local CBZ and no pages array in database".to_string(),
            ));
        }

        external_pages
            .iter()
            .enumerate()
            .map(|(index, entry)| ChapterPage {
                index,
                file_name: entry.file_name.clone(),
                url: format!("/api/chapters/{chapter_id}/pages/{index}"),
            })
            .collect::<Vec<_>>()
    };

    Ok(Json(ChapterPagesResponse {
        chapter_id,
        comic_id,
        comic_name,
        chapter_name,
        page_count: pages.len(),
        pages,
    }))
}

#[utoipa::path(
    get,
    path = "/api/library/{comic_id}/chapters/{chapter_id}/pages",
    tag = "db",
    params(
        ("comic_id" = String, Path, description = "Comic id"),
        ("chapter_id" = String, Path, description = "Chapter id")
    ),
    responses(
        (status = 200, description = "Chapter page URLs", body = ChapterPagesResponse),
        (status = 404, description = "Chapter not found", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse)
    )
)]
async fn list_library_chapter_pages(
    State(state): State<RestState>,
    Path((comic_id, chapter_id)): Path<(String, String)>,
) -> Result<Json<ChapterPagesResponse>, (StatusCode, String)> {
    let response = list_library_chapter_pages_impl(&state, &comic_id, &chapter_id)?;
    Ok(Json(response))
}

#[utoipa::path(
    get,
    path = "/api/chapters/{chapter_id}/pages/{page_index}",
    tag = "db",
    params(
        ("chapter_id" = String, Path, description = "Chapter id"),
        ("page_index" = usize, Path, description = "Page index (0-based)")
    ),
    responses(
        (status = 200, description = "Image bytes"),
        (status = 404, description = "Page not found", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse)
    )
)]
async fn get_chapter_page(
    State(state): State<RestState>,
    Path((chapter_id, page_index)): Path<(String, usize)>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    if let Some(response) = get_library_chapter_page_by_chapter_id(&state, &chapter_id, page_index)? {
        return Ok(response);
    }

    let chapter = state
        .service
        .get("chapters", &chapter_id)
        .map_err(internal_error)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Chapter not found".to_string()))?;

    let comic_id = chapter_value_as_string(&chapter, "comicId").ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "Chapter has no comicId".to_string(),
        )
    })?;
    let chapter_name = chapter_display_name(&chapter);
    let chapter_number = chapter_value_as_string(&chapter, "number");

    let comic = state
        .service
        .get("comics", &comic_id)
        .map_err(internal_error)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Comic not found".to_string()))?;
    let comic_name = chapter_value_as_string(&comic, "name").unwrap_or_else(|| comic_id.clone());

    let cbz_path = resolve_chapter_cbz_path(
        &state.comics_dir,
        &comic_id,
        &comic_name,
        &chapter_name,
        chapter_number.as_deref(),
    );

    if let Some(cbz_path) = cbz_path {
        let entries = list_image_entries(&cbz_path).map_err(internal_error)?;
        let page = entries.get(page_index).ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                "Page index out of bounds".to_string(),
            )
        })?;

        let bytes = read_entry_bytes(&cbz_path, page.archive_index).map_err(internal_error)?;
        let content_type = from_path(&page.file_name).first_or_octet_stream();

        return Ok((
            [
                (header::CONTENT_TYPE, content_type.to_string()),
                (header::CACHE_CONTROL, "public, max-age=300".to_string()),
            ],
            bytes,
        )
            .into_response());
    }

    let external_pages = chapter_external_pages(&chapter);
    let external = external_pages.get(page_index).ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            "Page index out of bounds".to_string(),
        )
    })?;

    if external.source.starts_with("http://") || external.source.starts_with("https://") {
        return Ok(Redirect::temporary(&external.source).into_response());
    }

    let file_path = resolve_external_page_file_path(&state.comics_dir, &external.source)
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                "External page source is not a supported URL or local file path".to_string(),
            )
        })?;

    let bytes = fs::read(&file_path).map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to read chapter page file: {error}"),
        )
    })?;
    let content_type = from_path(&file_path).first_or_octet_stream();

    Ok((
        [
            (header::CONTENT_TYPE, content_type.to_string()),
            (header::CACHE_CONTROL, "public, max-age=300".to_string()),
        ],
        bytes,
    )
        .into_response())
}

#[utoipa::path(
    get,
    path = "/api/library/{comic_id}/chapters/{chapter_id}/pages/{page_index}",
    tag = "db",
    params(
        ("comic_id" = String, Path, description = "Comic id"),
        ("chapter_id" = String, Path, description = "Chapter id"),
        ("page_index" = usize, Path, description = "Page index")
    ),
    responses(
        (status = 200, description = "Image bytes"),
        (status = 404, description = "Page not found", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse)
    )
)]
async fn get_library_chapter_page(
    State(state): State<RestState>,
    Path((comic_id, chapter_id, page_index)): Path<(String, String, usize)>,
) -> Result<Response, (StatusCode, String)> {
    get_library_chapter_page_impl(&state, &comic_id, &chapter_id, page_index)
}

#[utoipa::path(
    get,
    path = "/api/comics/{comic_id}/cover",
    tag = "db",
    params(
        ("comic_id" = String, Path, description = "Comic id")
    ),
    responses(
        (status = 200, description = "Cover image bytes"),
        (status = 302, description = "Redirect to remote cover URL"),
        (status = 404, description = "Cover not found", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse)
    )
)]
async fn get_comic_cover(
    State(state): State<RestState>,
    Path(comic_id): Path<String>,
) -> Result<Response, (StatusCode, String)> {
    if let Some(response) = get_library_comic_cover(&state, &comic_id)? {
        return Ok(response);
    }

    let comic = state
        .service
        .get("comics", &comic_id)
        .map_err(internal_error)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Comic not found".to_string()))?;

    let comic_name = chapter_value_as_string(&comic, "name").unwrap_or_else(|| comic_id.clone());
    let path = if let Some(cover_ref) = chapter_value_as_string(&comic, "coverUrl")
        .or_else(|| chapter_value_as_string(&comic, "cover"))
        .or_else(|| chapter_value_as_string(&comic, "image"))
    {
        let trimmed = cover_ref.trim();
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            return Ok(Redirect::temporary(trimmed).into_response());
        }

        resolve_comic_cover_path(&state.comics_dir, &comic_id, &comic_name, trimmed)
    } else {
        find_local_cover_in_comic_dir(&state.comics_dir, &comic_id, &comic_name)
    }
    .ok_or_else(|| (StatusCode::NOT_FOUND, "Cover image not found".to_string()))?;
    let bytes = fs::read(&path).map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to read cover image: {error}"),
        )
    })?;
    let content_type = from_path(&path).first_or_octet_stream();

    Ok((
        [
            (header::CONTENT_TYPE, content_type.to_string()),
            (header::CACHE_CONTROL, "public, max-age=300".to_string()),
        ],
        bytes,
    )
        .into_response())
}

fn get_library_comic_cover(
    state: &RestState,
    comic_id: &str,
) -> Result<Option<Response>, (StatusCode, String)> {
    let Some(mut comic) = state
        .library_service
        .get_comic(comic_id)
        .map_err(internal_error)? else {
        return Ok(None);
    };

    if let Some(local_file) = comic
        .cover
        .as_ref()
        .and_then(|cover| cover.local_file.as_deref())
        .filter(|value| !value.trim().is_empty())
    {
        let path = state.comics_dir.join(&comic.slug).join(local_file);
        if path.is_file() {
            let bytes = fs::read(&path).map_err(|error| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to read cover image: {error}"),
                )
            })?;
            let content_type = from_path(&path).first_or_octet_stream();
            return Ok(Some((
                [
                    (header::CONTENT_TYPE, content_type.to_string()),
                    (header::CACHE_CONTROL, "public, max-age=300".to_string()),
                ],
                bytes,
            )
                .into_response()));
        }
    }

    let has_remote_cover = comic
        .cover
        .as_ref()
        .and_then(|cover| cover.remote_url.as_deref())
        .is_some_and(|value| value.starts_with("http://") || value.starts_with("https://"));
    if has_remote_cover {
        state
            .library_service
            .save_comic(&comic)
            .map_err(internal_error)?;
        comic = state
            .library_service
            .get_comic(comic_id)
            .map_err(internal_error)?
            .ok_or_else(|| (StatusCode::NOT_FOUND, "Comic not found".to_string()))?;

        if let Some(local_file) = comic
            .cover
            .as_ref()
            .and_then(|cover| cover.local_file.as_deref())
            .filter(|value| !value.trim().is_empty())
        {
            let path = state.comics_dir.join(&comic.slug).join(local_file);
            if path.is_file() {
                let bytes = fs::read(&path).map_err(|error| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Failed to read cover image: {error}"),
                    )
                })?;
                let content_type = from_path(&path).first_or_octet_stream();
                return Ok(Some((
                    [
                        (header::CONTENT_TYPE, content_type.to_string()),
                        (header::CACHE_CONTROL, "public, max-age=300".to_string()),
                    ],
                    bytes,
                )
                    .into_response()));
            }
        }
    }

    if let Some(remote_url) = comic
        .cover
        .as_ref()
        .and_then(|cover| cover.remote_url.as_deref())
        .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
    {
        return Ok(Some(Redirect::temporary(remote_url).into_response()));
    }

    Ok(None)
}

#[utoipa::path(
    post,
    path = "/api/chapters/mark",
    tag = "db",
    request_body = MarkChaptersBody,
    responses(
        (status = 200, description = "Marked chapters as read/unread", body = MarkChaptersResponse),
        (status = 400, description = "Invalid request", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse)
    )
)]
async fn mark_chapters_read_state(
    State(state): State<RestState>,
    Json(payload): Json<MarkChaptersBody>,
) -> Result<Json<MarkChaptersResponse>, (StatusCode, String)> {
    if payload.chapter_ids.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "chapterIds cannot be empty".to_string()));
    }

    let (updated, skipped) = state
        .service
        .mark_chapters_read_state(&payload.chapter_ids, payload.read)
        .map_err(internal_error)?;

    Ok(Json(MarkChaptersResponse { updated, skipped }))
}

#[utoipa::path(
    post,
    path = "/api/import/comic",
    tag = "db",
    request_body = ImportComicBody,
    responses(
        (status = 200, description = "Imported comic and chapters", body = ImportComicResponse),
        (status = 400, description = "Invalid request", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse)
    )
)]
async fn import_comic(
    State(state): State<RestState>,
    Json(payload): Json<ImportComicBody>,
) -> Result<Json<ImportComicResponse>, (StatusCode, String)> {
    let target_comic_id = payload
        .data
        .target_comic_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let comic_obj = payload
        .data
        .comic
        .as_object()
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "Missing data.comic object".to_string()))?;

    let source_tag = normalize_source_tag(
        pick_string_from_map(comic_obj, &["sourceTag", "repo", "tag", "source", "provider"])
            .as_deref(),
    )
    .unwrap_or_else(|| "web-scrapper".to_string());
    let comic_site_id = pick_string_from_map(comic_obj, &["sourceSiteId", "siteId", "id", "externalId"]);
    let comic_site_link = pick_string_from_map(comic_obj, &["sourceSiteLink", "siteLink", "url", "link"]);
    let comic_name = pick_string_from_map(comic_obj, &["name", "title"])
        .or_else(|| comic_site_id.clone())
        .unwrap_or_else(|| "Untitled".to_string());
    let comic_id = stable_import_id(
        "comic",
        &[
            source_tag.as_str(),
            comic_site_id
                .as_deref()
                .or(comic_site_link.as_deref())
                .or(Some(comic_name.as_str()))
                .unwrap_or("untitled"),
        ],
    );

    let mut chapters_imported = 0usize;
    let mut chapters_skipped = 0usize;
    let mut chapters_by_number = std::collections::BTreeMap::<String, crate::domain::ComicChapter>::new();

    for (index, chapter_raw) in payload.data.chapters.iter().enumerate() {
        let Some(chapter_obj) = chapter_raw.as_object() else {
            chapters_skipped += 1;
            continue;
        };

        let chapter_site_id = pick_string_from_map(chapter_obj, &["chapterSiteId", "siteId", "id", "externalId"]);
        let chapter_site_url = pick_string_from_map(chapter_obj, &["chapterSiteUrl", "siteLink", "url", "link"]);
        let chapter_number =
            pick_string_from_map(chapter_obj, &["number", "chapterNumber"]).unwrap_or_else(|| (index + 1).to_string());
        let chapter_title = pick_string_from_map(chapter_obj, &["name", "title"]);
        let language = pick_string_from_map(chapter_obj, &["language", "lang"]);
        let mut language_codes = pick_string_array_from_map(chapter_obj, &["languageCodes", "languages"]);
        if let Some(language) = language.as_ref() {
            if !language_codes.iter().any(|entry| entry == language) {
                language_codes.push(language.clone());
            }
        }
        let pages = parse_pages_value(chapter_obj.get("pages"))
            .into_iter()
            .enumerate()
            .filter_map(|(page_index, entry)| {
                let url = entry.get("url").and_then(Value::as_str)?.to_string();
                let file_name = entry
                    .get("fileName")
                    .and_then(Value::as_str)
                    .unwrap_or("page")
                    .to_string();
                Some(crate::domain::ComicPage {
                    index: page_index,
                    file_name,
                    url,
                })
            })
            .collect::<Vec<_>>();
        if pages.is_empty() && chapter_site_id.is_none() {
            chapters_skipped += 1;
            continue;
        }

        let chapter_key = normalize_chapter_number_token(&chapter_number);
        let chapter_id = stable_import_id("chapter", &[comic_id.as_str(), chapter_key.as_str()]);
        let variant_id = stable_import_id(
            "variant",
            &[
                chapter_id.as_str(),
                language.as_deref().unwrap_or("unknown"),
                source_tag.as_str(),
                chapter_site_id.as_deref().unwrap_or(chapter_number.as_str()),
            ],
        );
        let chapter_entry = chapters_by_number.entry(chapter_key).or_insert_with(|| crate::domain::ComicChapter {
            id: chapter_id.clone(),
            number: chapter_number.clone(),
            sort_key: parse_chapter_sort_key(&chapter_number),
            title: chapter_title.clone(),
            title_by_language: std::collections::BTreeMap::new(),
            available_languages: language_codes.clone(),
            variants: Vec::new(),
        });
        if let Some(title) = chapter_title.as_ref() {
            if let Some(language) = language.as_ref() {
                chapter_entry
                    .title_by_language
                    .insert(language.clone(), title.clone());
            }
            if chapter_entry.title.as_deref().unwrap_or_default().is_empty() {
                chapter_entry.title = Some(title.clone());
            }
        }
        for code in &language_codes {
            if !chapter_entry.available_languages.iter().any(|entry| entry == code) {
                chapter_entry.available_languages.push(code.clone());
            }
        }
        chapter_entry.variants.push(crate::domain::ChapterVariant {
            id: variant_id,
            language,
            plugin_id: pick_string_from_map(comic_obj, &["metadataPluginId", "pluginId"]),
            plugin_tag: Some(source_tag.clone()),
            plugin_name: pick_string_from_map(comic_obj, &["metadataPluginName", "pluginName"]),
            chapter_site_id,
            chapter_site_url,
            pages,
            offline: None,
            source_data: Value::Object(chapter_obj.clone()),
            name: chapter_title,
        });
        chapters_imported += 1;
    }

    let imported_metadata = crate::domain::ComicMetadata {
        schema_version: 1,
        id: comic_id.clone(),
        slug: slugify_title(&comic_name),
        title: comic_name.clone(),
        description: pick_string_from_map(comic_obj, &["description", "synopsis"]),
        publisher: pick_string_from_map(comic_obj, &["publisher"]),
        status: pick_string_from_map(comic_obj, &["status"]),
        content_type: pick_string_from_map(comic_obj, &["contentType", "type"]),
        cover: Some(crate::domain::ComicCover {
            remote_url: pick_string_from_map(comic_obj, &["cover"]),
            local_file: None,
        }),
        sources: vec![crate::domain::ComicSource {
            plugin_id: pick_string_from_map(comic_obj, &["metadataPluginId", "pluginId"]),
            plugin_tag: Some(source_tag),
            plugin_name: pick_string_from_map(comic_obj, &["metadataPluginName", "pluginName"]),
            source_site_id: comic_site_id,
            source_site_url: comic_site_link,
        }],
        languages: pick_string_array_from_map(comic_obj, &["languageCodes", "languages"]),
        chapters: chapters_by_number.into_values().collect(),
        updated_at: now_unix_string(),
    };

    let metadata = if let Some(target_id) = target_comic_id.as_deref() {
        let existing = state
            .library_service
            .get_comic(target_id)
            .map_err(internal_error)?
            .ok_or_else(|| (StatusCode::NOT_FOUND, "Target comic not found".to_string()))?;
        merge_comic_metadata(existing, imported_metadata)
    } else {
        imported_metadata
    };

    state
        .library_service
        .save_comic(&metadata)
        .map_err(internal_error)?;

    Ok(Json(ImportComicResponse {
        comic_id: metadata.id,
        chapters_imported,
        chapters_skipped,
    }))
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|entry| {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn source_identity(source: &crate::domain::ComicSource) -> String {
    let plugin_tag = source.plugin_tag.as_deref().unwrap_or_default().trim().to_lowercase();
    let site_id = source
        .source_site_id
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let site_url = source
        .source_site_url
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    format!("{plugin_tag}|{site_id}|{site_url}")
}

fn variant_identity(variant: &crate::domain::ChapterVariant) -> String {
    let plugin_tag = variant.plugin_tag.as_deref().unwrap_or_default().trim().to_lowercase();
    let plugin_id = variant.plugin_id.as_deref().unwrap_or_default().trim().to_lowercase();
    let language = variant.language.as_deref().unwrap_or_default().trim().to_lowercase();
    let chapter_site_id = variant
        .chapter_site_id
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let chapter_site_url = variant
        .chapter_site_url
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    format!("{plugin_tag}|{plugin_id}|{language}|{chapter_site_id}|{chapter_site_url}")
}

fn compare_chapter_numbers(left: &str, right: &str) -> std::cmp::Ordering {
    match (parse_chapter_sort_key(left), parse_chapter_sort_key(right)) {
        (Some(left_value), Some(right_value)) => left_value
            .partial_cmp(&right_value)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.cmp(right)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => left.cmp(right),
    }
}

fn merge_chapter(existing: &mut crate::domain::ComicChapter, incoming: crate::domain::ComicChapter) {
    if existing.title.as_deref().unwrap_or_default().trim().is_empty() {
        existing.title = normalize_optional_string(incoming.title);
    }
    if existing.sort_key.is_none() {
        existing.sort_key = incoming.sort_key;
    }

    for (language, title) in incoming.title_by_language {
        if !title.trim().is_empty() {
            existing.title_by_language.entry(language).or_insert(title);
        }
    }

    for language in incoming.available_languages {
        if !language.trim().is_empty() && !existing.available_languages.iter().any(|entry| entry == &language) {
            existing.available_languages.push(language);
        }
    }

    let mut variant_keys = existing
        .variants
        .iter()
        .map(variant_identity)
        .collect::<HashSet<_>>();
    for variant in incoming.variants {
        let key = variant_identity(&variant);
        if variant_keys.contains(&key) {
            continue;
        }
        variant_keys.insert(key);
        existing.variants.push(variant);
    }
}

fn merge_comic_metadata(
    mut existing: crate::domain::ComicMetadata,
    incoming: crate::domain::ComicMetadata,
) -> crate::domain::ComicMetadata {
    if existing.description.as_deref().unwrap_or_default().trim().is_empty() {
        existing.description = normalize_optional_string(incoming.description);
    }
    if existing.publisher.as_deref().unwrap_or_default().trim().is_empty() {
        existing.publisher = normalize_optional_string(incoming.publisher);
    }
    if existing.status.as_deref().unwrap_or_default().trim().is_empty() {
        existing.status = normalize_optional_string(incoming.status);
    }
    if existing.content_type.as_deref().unwrap_or_default().trim().is_empty() {
        existing.content_type = normalize_optional_string(incoming.content_type);
    }

    match (&mut existing.cover, incoming.cover) {
        (Some(existing_cover), Some(incoming_cover)) => {
            if existing_cover.remote_url.as_deref().unwrap_or_default().trim().is_empty() {
                existing_cover.remote_url = normalize_optional_string(incoming_cover.remote_url);
            }
            if existing_cover.local_file.as_deref().unwrap_or_default().trim().is_empty() {
                existing_cover.local_file = normalize_optional_string(incoming_cover.local_file);
            }
        }
        (None, Some(incoming_cover)) => existing.cover = Some(incoming_cover),
        _ => {}
    }

    for language in incoming.languages {
        if !language.trim().is_empty() && !existing.languages.iter().any(|entry| entry == &language) {
            existing.languages.push(language);
        }
    }

    let mut source_keys = existing.sources.iter().map(source_identity).collect::<HashSet<_>>();
    for source in incoming.sources {
        let key = source_identity(&source);
        if source_keys.contains(&key) {
            continue;
        }
        source_keys.insert(key);
        existing.sources.push(source);
    }

    let mut chapter_indexes = std::collections::HashMap::<String, usize>::new();
    for (index, chapter) in existing.chapters.iter().enumerate() {
        chapter_indexes.insert(normalize_chapter_number_token(&chapter.number), index);
    }

    for chapter in incoming.chapters {
        let key = normalize_chapter_number_token(&chapter.number);
        if let Some(index) = chapter_indexes.get(&key).copied() {
            if let Some(existing_chapter) = existing.chapters.get_mut(index) {
                merge_chapter(existing_chapter, chapter);
            }
        } else {
            chapter_indexes.insert(key, existing.chapters.len());
            existing.chapters.push(chapter);
        }
    }

    existing
        .chapters
        .sort_by(|left, right| compare_chapter_numbers(&left.number, &right.number));
    existing.updated_at = now_unix_string();
    existing
}

#[utoipa::path(
    post,
    path = "/api/admin/migrate-legacy",
    tag = "db",
    request_body = MigrateLegacyBody,
    responses(
        (status = 200, description = "Legacy migration result", body = MigrateLegacyResponse),
        (status = 404, description = "Admin endpoints disabled", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse)
    )
)]
async fn migrate_legacy(
    State(state): State<RestState>,
    Json(payload): Json<MigrateLegacyBody>,
) -> Result<Json<MigrateLegacyResponse>, (StatusCode, String)> {
    if !state.admin_enabled {
        return Err((StatusCode::NOT_FOUND, "Not Found".to_string()));
    }

    let report = state
        .admin_service
        .migrate_legacy(payload.legacy_db_path)
        .map_err(internal_error)?;

    let response = match report {
        Some(report) => MigrateLegacyResponse {
            performed: true,
            imported_rows: report.imported_rows,
            legacy_db_path: Some(report.legacy_db_path),
        },
        None => MigrateLegacyResponse {
            performed: false,
            imported_rows: 0,
            legacy_db_path: None,
        },
    };

    Ok(Json(response))
}

fn admin_endpoints_enabled() -> bool {
    if let Ok(value) = std::env::var("REST_ADMIN_ENABLED") {
        let normalized = value.trim().to_ascii_lowercase();
        return matches!(normalized.as_str(), "1" | "true" | "yes" | "on");
    }

    cfg!(debug_assertions)
}

fn list_library_chapter_pages_impl(
    state: &RestState,
    comic_id: &str,
    chapter_id: &str,
) -> Result<ChapterPagesResponse, (StatusCode, String)> {
    let preferred_languages = Vec::<String>::new();
    let (comic, chapter, variant) = state
        .library_service
        .resolve_pages(comic_id, chapter_id, &preferred_languages)
        .map_err(internal_error)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Chapter not found".to_string()))?;

    let pages = if let Some(cbz_path) = resolve_variant_cbz_path(&state.comics_dir, &comic, &variant) {
        let entries = list_image_entries(&cbz_path).map_err(internal_error)?;
        if entries.is_empty() {
            return Err((StatusCode::NOT_FOUND, "CBZ has no image pages".to_string()));
        }

        entries
            .iter()
            .enumerate()
            .map(|(index, entry)| ChapterPage {
                index,
                file_name: entry.file_name.clone(),
                url: format!("/api/library/{comic_id}/chapters/{chapter_id}/pages/{index}"),
            })
            .collect::<Vec<_>>()
    } else {
        variant
            .pages
            .iter()
            .enumerate()
            .map(|(index, entry)| ChapterPage {
                index,
                file_name: entry.file_name.clone(),
                url: format!("/api/library/{comic_id}/chapters/{chapter_id}/pages/{index}"),
            })
            .collect::<Vec<_>>()
    };

    Ok(ChapterPagesResponse {
        chapter_id: chapter.id.clone(),
        comic_id: comic.id.clone(),
        comic_name: comic.title.clone(),
        chapter_name: chapter.title.clone().unwrap_or_else(|| chapter.number.clone()),
        page_count: pages.len(),
        pages,
    })
}

async fn list_library_chapter_pages_by_chapter_id(
    state: &RestState,
    chapter_id: &str,
) -> Result<Option<ChapterPagesResponse>, (StatusCode, String)> {
    let comics = state.library_service.list_comics().map_err(internal_error)?;
    for comic in comics {
        let Some(metadata) = state
            .library_service
            .get_comic(&comic.comic_id)
            .map_err(internal_error)? else {
            continue;
        };
        if metadata.chapters.iter().any(|chapter| chapter.id == chapter_id) {
            return list_library_chapter_pages_impl(state, &metadata.id, chapter_id).map(Some);
        }
    }
    Ok(None)
}

fn get_library_chapter_page_impl(
    state: &RestState,
    comic_id: &str,
    chapter_id: &str,
    page_index: usize,
) -> Result<Response, (StatusCode, String)> {
    let preferred_languages = Vec::<String>::new();
    let (comic, _chapter, variant) = state
        .library_service
        .resolve_pages(comic_id, chapter_id, &preferred_languages)
        .map_err(internal_error)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Chapter not found".to_string()))?;

    if let Some(cbz_path) = resolve_variant_cbz_path(&state.comics_dir, &comic, &variant) {
        let entries = list_image_entries(&cbz_path).map_err(internal_error)?;
        let page = entries.get(page_index).ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                "Page index out of bounds".to_string(),
            )
        })?;
        let bytes = read_entry_bytes(&cbz_path, page.archive_index).map_err(internal_error)?;
        let content_type = from_path(&page.file_name).first_or_octet_stream();
        return Ok((
            [
                (header::CONTENT_TYPE, content_type.to_string()),
                (header::CACHE_CONTROL, "public, max-age=300".to_string()),
            ],
            bytes,
        )
            .into_response());
    }

    let page = variant.pages.get(page_index).ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            "Page index out of bounds".to_string(),
        )
    })?;
    if page.url.starts_with("http://") || page.url.starts_with("https://") {
        return Ok(Redirect::temporary(&page.url).into_response());
    }

    let local_path = state.comics_dir.join(&comic.slug).join(&page.url);
    let bytes = fs::read(&local_path).map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to read chapter page file: {error}"),
        )
    })?;
    let content_type = from_path(&local_path).first_or_octet_stream();
    Ok((
        [
            (header::CONTENT_TYPE, content_type.to_string()),
            (header::CACHE_CONTROL, "public, max-age=300".to_string()),
        ],
        bytes,
    )
        .into_response())
}

fn get_library_chapter_page_by_chapter_id(
    state: &RestState,
    chapter_id: &str,
    page_index: usize,
) -> Result<Option<Response>, (StatusCode, String)> {
    let comics = state.library_service.list_comics().map_err(internal_error)?;
    for comic in comics {
        let Some(metadata) = state
            .library_service
            .get_comic(&comic.comic_id)
            .map_err(internal_error)? else {
            continue;
        };
        if metadata.chapters.iter().any(|chapter| chapter.id == chapter_id) {
            return get_library_chapter_page_impl(state, &metadata.id, chapter_id, page_index)
                .map(Some);
        }
    }
    Ok(None)
}

fn internal_error(error: AppError) -> (StatusCode, String) {
    match error {
        AppError::InvalidTable(message) => (StatusCode::BAD_REQUEST, message),
        AppError::Validation(message) => (StatusCode::BAD_REQUEST, message),
        AppError::Infrastructure(message) => (StatusCode::INTERNAL_SERVER_ERROR, message),
    }
}

fn chapter_value_as_string(record: &DbRecord, field: &str) -> Option<String> {
    record
        .data
        .get(field)
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn pick_string_from_map(map: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = map.get(*key) {
            match value {
                Value::String(raw) => {
                    let trimmed = raw.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_string());
                    }
                }
                Value::Number(number) => {
                    return Some(number.to_string());
                }
                _ => {}
            }
        }
    }
    None
}

fn normalize_source_tag(value: Option<&str>) -> Option<String> {
    let raw = value?.trim().to_ascii_lowercase();
    if raw.is_empty() {
        return None;
    }

    let mut out = String::new();
    let mut last_dash = false;
    for ch in raw.chars() {
        let normalized = if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-') {
            ch
        } else {
            '-'
        };
        if normalized == '-' {
            if last_dash {
                continue;
            }
            last_dash = true;
        } else {
            last_dash = false;
        }
        out.push(normalized);
    }

    let cleaned = out.trim_matches('-').to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn stable_import_id(prefix: &str, parts: &[&str]) -> String {
    let normalized = parts
        .iter()
        .map(|part| sanitize_segment(part).to_ascii_lowercase().replace(' ', "-"))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(":");

    if normalized.is_empty() {
        format!("{prefix}:untitled")
    } else {
        format!("{prefix}:{normalized}")
    }
}

fn infer_file_name_from_source(source: &str, index: usize) -> String {
    let without_query = source
        .split_once('?')
        .map(|(prefix, _)| prefix)
        .unwrap_or(source);
    let file_name = FsPath::new(without_query)
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string);

    file_name.unwrap_or_else(|| format!("page-{}.jpg", index + 1))
}

fn parse_pages_value(value: Option<&Value>) -> Vec<Value> {
    let Some(raw) = value else {
        return Vec::new();
    };

    let parsed = match raw {
        Value::Array(values) => Value::Array(values.clone()),
        Value::String(text) => match serde_json::from_str::<Value>(text) {
            Ok(value) => value,
            Err(_) => return Vec::new(),
        },
        _ => return Vec::new(),
    };

    let Some(items) = parsed.as_array() else {
        return Vec::new();
    };

    items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| match item {
            Value::String(source) => {
                let trimmed = source.trim();
                if trimmed.is_empty() {
                    return None;
                }
                Some(Value::Object(
                    [
                        ("url".to_string(), Value::String(trimmed.to_string())),
                        (
                            "fileName".to_string(),
                            Value::String(infer_file_name_from_source(trimmed, index)),
                        ),
                    ]
                    .into_iter()
                    .collect(),
                ))
            }
            Value::Object(map) => {
                let source = pick_string_from_map(map, &["url", "src", "path", "data"])?;
                let file_name = pick_string_from_map(map, &["fileName", "name"])
                    .unwrap_or_else(|| infer_file_name_from_source(&source, index));
                let mut next = map.clone();
                next.insert("url".to_string(), Value::String(source));
                next.insert("fileName".to_string(), Value::String(file_name));
                Some(Value::Object(next))
            }
            _ => None,
        })
        .collect()
}

fn chapter_display_name(chapter: &DbRecord) -> String {
    chapter_value_as_string(chapter, "name")
        .or_else(|| {
            chapter_value_as_string(chapter, "number").map(|number| format!("Chapter {number}"))
        })
        .unwrap_or_else(|| "chapter".to_string())
}

#[derive(Clone)]
struct ExternalPageEntry {
    file_name: String,
    source: String,
}

fn chapter_external_pages(chapter: &DbRecord) -> Vec<ExternalPageEntry> {
    let Some(values) = chapter.data.get("pages").and_then(|value| value.as_array()) else {
        return Vec::new();
    };

    values
        .iter()
        .enumerate()
        .filter_map(|(index, value)| external_page_entry(value, index))
        .collect()
}

fn external_page_entry(value: &Value, index: usize) -> Option<ExternalPageEntry> {
    match value {
        Value::String(source) => {
            let source = source.trim();
            if source.is_empty() {
                return None;
            }

            Some(ExternalPageEntry {
                file_name: infer_page_file_name(source, index, None),
                source: source.to_string(),
            })
        }
        Value::Object(map) => {
            let source = map
                .get("url")
                .or_else(|| map.get("src"))
                .or_else(|| map.get("path"))
                .or_else(|| map.get("data"))
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            let explicit_name = map.get("fileName").or_else(|| map.get("name")).and_then(|value| {
                value
                    .as_str()
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
            });

            Some(ExternalPageEntry {
                file_name: infer_page_file_name(source, index, explicit_name),
                source: source.to_string(),
            })
        }
        _ => None,
    }
}

fn infer_page_file_name(source: &str, index: usize, explicit_name: Option<&str>) -> String {
    if let Some(name) = explicit_name {
        return name.to_string();
    }

    let without_query = source
        .split_once('?')
        .map(|(prefix, _)| prefix)
        .unwrap_or(source);

    let name = FsPath::new(without_query)
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());

    match name {
        Some(value) => value.to_string(),
        None => format!("page-{}.jpg", index + 1),
    }
}

fn resolve_external_page_file_path(comics_dir: &FsPath, source: &str) -> Option<PathBuf> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return None;
    }

    let direct = FsPath::new(trimmed);
    if direct.is_file() {
        return Some(direct.to_path_buf());
    }

    let normalized = trimmed.trim_start_matches('/');
    if normalized.is_empty() || normalized.contains("..") {
        return None;
    }

    let under_comics = comics_dir.join(normalized);
    if under_comics.is_file() {
        return Some(under_comics);
    }

    None
}

fn resolve_chapter_cbz_path(
    comics_dir: &FsPath,
    comic_id: &str,
    comic_name: &str,
    chapter_name: &str,
    chapter_number: Option<&str>,
) -> Option<PathBuf> {
    let comic_base = sanitize_segment(comic_name);
    let chapter_file_candidates = chapter_file_candidates(chapter_name, chapter_number);
    let mut dir_candidates = vec![
        comics_dir.join(&comic_base),
        comics_dir.join(sanitize_segment(comic_id)),
    ];

    if let Ok(entries) = fs::read_dir(comics_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
                if name == comic_base || name.starts_with(&format!("{comic_base} (")) {
                    dir_candidates.push(path);
                }
            }
        }
    }

    for dir in dir_candidates {
        for candidate in &chapter_file_candidates {
            let cbz = dir.join(candidate);
            if cbz.exists() {
                return Some(cbz);
            }
        }
    }

    None
}

fn resolve_cover_image_path(comics_dir: &FsPath, cover_ref: &str) -> Option<PathBuf> {
    let normalized = cover_ref.trim().trim_start_matches('/');
    if normalized.is_empty() || normalized.contains("..") {
        return None;
    }

    let direct = comics_dir.join(normalized);
    if direct.is_file() {
        return Some(direct);
    }

    let file_name = FsPath::new(normalized)
        .file_name()
        .and_then(|value| value.to_str())?;

    let covers_dir_candidate = comics_dir.join("covers").join(file_name);
    if covers_dir_candidate.is_file() {
        return Some(covers_dir_candidate);
    }

    if let Ok(entries) = fs::read_dir(comics_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let candidate = path.join(file_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

fn resolve_comic_cover_path(
    comics_dir: &FsPath,
    comic_id: &str,
    comic_name: &str,
    cover_ref: &str,
) -> Option<PathBuf> {
    let file_name = FsPath::new(cover_ref)
        .file_name()
        .and_then(|value| value.to_str())?;
    let comic_base = sanitize_segment(comic_name);

    let mut dir_candidates = vec![
        comics_dir.join(&comic_base),
        comics_dir.join(sanitize_segment(comic_id)),
    ];

    if let Ok(entries) = fs::read_dir(comics_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
                if name == comic_base || name.starts_with(&format!("{comic_base} (")) {
                    dir_candidates.push(path.clone());
                }
            }
        }
    }

    for dir in dir_candidates {
        let candidate = dir.join(file_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    resolve_cover_image_path(comics_dir, cover_ref)
}

fn find_local_cover_in_comic_dir(
    comics_dir: &FsPath,
    comic_id: &str,
    comic_name: &str,
) -> Option<PathBuf> {
    let comic_base = sanitize_segment(comic_name);
    let mut dir_candidates = vec![
        comics_dir.join(&comic_base),
        comics_dir.join(sanitize_segment(comic_id)),
    ];

    if let Ok(entries) = fs::read_dir(comics_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
                if name == comic_base || name.starts_with(&format!("{comic_base} (")) {
                    dir_candidates.push(path);
                }
            }
        }
    }

    for dir in dir_candidates {
        // Prefer explicit cover filenames first.
        for file_name in [
            "cover.jpg",
            "cover.jpeg",
            "cover.png",
            "cover.webp",
            "cover.avif",
        ] {
            let candidate = dir.join(file_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }

        // Fallback to first image file in the comic directory.
        if let Ok(entries) = fs::read_dir(&dir) {
            let mut image_files = entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.is_file())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .map(is_image_file)
                        .unwrap_or(false)
                })
                .collect::<Vec<_>>();
            image_files.sort();
            if let Some(first) = image_files.into_iter().next() {
                return Some(first);
            }
        }
    }

    None
}

fn chapter_file_candidates(chapter_name: &str, chapter_number: Option<&str>) -> Vec<String> {
    let mut values = Vec::new();
    let mut seen = HashSet::new();
    let sanitized_name = sanitize_segment(chapter_name);

    if seen.insert(sanitized_name.clone()) {
        values.push(format!("{sanitized_name}.cbz"));
    }

    if let Some(number) = chapter_number {
        let sanitized_number = sanitize_segment(number);
        if seen.insert(sanitized_number.clone()) {
            values.push(format!("{sanitized_number}.cbz"));
        }

        let old_format = sanitize_segment(&format!("{number} - {chapter_name}"));
        if seen.insert(old_format.clone()) {
            values.push(format!("{old_format}.cbz"));
        }

        let fallback = sanitize_segment(&format!("Chapter {number}"));
        if seen.insert(fallback.clone()) {
            values.push(format!("{fallback}.cbz"));
        }
    }

    values
}

fn sanitize_segment(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        let accepted = ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | ' ');
        if accepted {
            out.push(ch);
        } else {
            out.push('_');
        }
    }

    let cleaned = out.trim().trim_start_matches('.').to_string();
    if cleaned.is_empty() {
        "untitled".to_string()
    } else if cleaned.len() > 180 {
        cleaned[..180].to_string()
    } else {
        cleaned
    }
}

fn pick_string_array_from_map(map: &Map<String, Value>, keys: &[&str]) -> Vec<String> {
    for key in keys {
        match map.get(*key) {
            Some(Value::Array(values)) => {
                let parsed = values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
                    .collect::<Vec<_>>();
                if !parsed.is_empty() {
                    return parsed;
                }
            }
            Some(Value::String(value)) if !value.trim().is_empty() => {
                return value
                    .split(',')
                    .map(str::trim)
                    .filter(|entry| !entry.is_empty())
                    .map(ToString::to_string)
                    .collect();
            }
            _ => {}
        }
    }
    Vec::new()
}

fn normalize_chapter_number_token(value: &str) -> String {
    let normalized = value.trim().replace(',', ".");
    if normalized.is_empty() {
        return "chapter".to_string();
    }
    if let Ok(parsed) = normalized.parse::<f64>() {
        if parsed.is_finite() {
            return parsed.to_string();
        }
    }
    normalized.to_lowercase()
}

fn parse_chapter_sort_key(value: &str) -> Option<f64> {
    let normalized = value.trim().replace(',', ".");
    normalized.parse::<f64>().ok().filter(|entry| entry.is_finite())
}

fn slugify_title(value: &str) -> String {
    let mut out = String::new();
    let mut previous_dash = false;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            previous_dash = false;
        } else if !previous_dash {
            out.push('-');
            previous_dash = true;
        }
    }
    let cleaned = out.trim_matches('-').to_string();
    if cleaned.is_empty() {
        "comic".to_string()
    } else {
        cleaned
    }
}

fn fetch_pages_for_variant(
    state: &RestState,
    variant: &crate::domain::ChapterVariant,
) -> Result<Vec<crate::domain::ComicPage>, AppError> {
    let plugin_id = variant
        .plugin_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::Validation(format!("Variant {} has no pluginId", variant.id)))?;
    let chapter_site_id = variant
        .chapter_site_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::Validation(format!("Variant {} has no chapterSiteId", variant.id)))?;

    let plugin = state
        .service
        .get("plugins", plugin_id)?
        .ok_or_else(|| AppError::Validation(format!("Plugin {plugin_id} is not installed")))?;
    let plugin_data = plugin
        .data
        .as_object()
        .ok_or_else(|| AppError::Validation(format!("Plugin {plugin_id} has invalid metadata")))?;

    let endpoint = plugin_data
        .get("endpoint")
        .and_then(Value::as_str)
        .or_else(|| plugin_data.get("url").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::Validation(format!("Plugin {plugin_id} has no endpoint")))?;

    let response = ureq::post(&format!("{}/getPages", endpoint.trim_end_matches('/')))
        .header("content-type", "application/json")
        .send(serde_json::json!({ "chapterSiteId": chapter_site_id }).to_string())
        .map_err(|error| AppError::infrastructure(format!("Failed to fetch pages from plugin {plugin_id}: {error}")))?;

    let value: Value = serde_json::from_reader(response.into_body().into_reader())
        .map_err(|error| AppError::infrastructure(format!("Invalid getPages response from plugin {plugin_id}: {error}")))?;
    Ok(normalize_comic_pages(&value))
}

fn normalize_comic_pages(raw: &Value) -> Vec<crate::domain::ComicPage> {
    let Some(entries) = raw.as_array() else {
        return Vec::new();
    };

    entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            if let Some(url) = entry.as_str().map(str::trim).filter(|value| !value.is_empty()) {
                return Some(crate::domain::ComicPage {
                    index,
                    file_name: format!("page-{}", index + 1),
                    url: url.to_string(),
                });
            }

            let record = entry.as_object()?;
            let url = record
                .get("url")
                .and_then(Value::as_str)
                .or_else(|| record.get("src").and_then(Value::as_str))
                .or_else(|| record.get("path").and_then(Value::as_str))
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            let file_name = record
                .get("fileName")
                .and_then(Value::as_str)
                .or_else(|| record.get("name").and_then(Value::as_str))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("page");

            Some(crate::domain::ComicPage {
                index,
                file_name: file_name.to_string(),
                url: url.to_string(),
            })
        })
        .collect()
}

fn write_chapter_cbz(
    comic_dir: &FsPath,
    target_path: &FsPath,
    pages: &[crate::domain::ComicPage],
) -> Result<(), AppError> {
    let temp_path = target_path.with_extension("cbz.part");
    let file = File::create(&temp_path).map_err(|error| AppError::infrastructure(error.to_string()))?;
    let mut archive = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

    for (index, page) in pages.iter().enumerate() {
        let entry_name = sanitize_cbz_entry_name(index, &page.file_name, &page.url);
        archive
            .start_file(entry_name, options)
            .map_err(|error| AppError::infrastructure(error.to_string()))?;
        let bytes = read_page_bytes_for_archive(comic_dir, page)?;
        archive
            .write_all(&bytes)
            .map_err(|error| AppError::infrastructure(error.to_string()))?;
    }

    archive
        .finish()
        .map_err(|error| AppError::infrastructure(error.to_string()))?;
    fs::rename(&temp_path, target_path).map_err(|error| AppError::infrastructure(error.to_string()))?;
    Ok(())
}

fn read_page_bytes_for_archive(comic_dir: &FsPath, page: &crate::domain::ComicPage) -> Result<Vec<u8>, AppError> {
    if page.url.starts_with("http://") || page.url.starts_with("https://") {
        let response = ureq::get(&page.url)
            .call()
            .map_err(|error| AppError::infrastructure(format!("Failed to download page {}: {error}", page.url)))?;
        let mut reader = response.into_body().into_reader();
        let mut bytes = Vec::new();
        reader
            .read_to_end(&mut bytes)
            .map_err(|error| AppError::infrastructure(format!("Failed to read page {}: {error}", page.url)))?;
        return Ok(bytes);
    }

    let path = comic_dir.join(page.url.trim_start_matches('/'));
    fs::read(&path).map_err(|error| AppError::infrastructure(format!("Failed to read {}: {error}", path.display())))
}

fn sanitize_cbz_entry_name(index: usize, file_name: &str, url: &str) -> String {
    let raw_name = FsPath::new(file_name)
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            FsPath::new(url)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("page")
        });
    let extension = FsPath::new(raw_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("jpg");
    format!("{:04}.{}", index + 1, extension)
}

fn now_unix_string() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn list_image_entries(cbz_path: &FsPath) -> Result<Vec<CbzPageEntry>, AppError> {
    let file = File::open(cbz_path).map_err(|error| AppError::infrastructure(error.to_string()))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| AppError::infrastructure(error.to_string()))?;

    let mut pages = Vec::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| AppError::infrastructure(error.to_string()))?;
        if !entry.is_file() {
            continue;
        }

        let file_name = entry.name().to_string();
        if !is_image_file(&file_name) {
            continue;
        }

        pages.push(CbzPageEntry {
            archive_index: index,
            file_name,
        });
    }

    Ok(pages)
}

fn read_entry_bytes(cbz_path: &FsPath, archive_index: usize) -> Result<Vec<u8>, AppError> {
    let file = File::open(cbz_path).map_err(|error| AppError::infrastructure(error.to_string()))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| AppError::infrastructure(error.to_string()))?;
    let mut entry = archive
        .by_index(archive_index)
        .map_err(|error| AppError::infrastructure(error.to_string()))?;
    let mut bytes = Vec::new();
    entry
        .read_to_end(&mut bytes)
        .map_err(|error| AppError::infrastructure(error.to_string()))?;
    Ok(bytes)
}

fn is_image_file(path: &str) -> bool {
    path.rsplit('.')
        .next()
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "avif"
            )
        })
        .unwrap_or(false)
}
