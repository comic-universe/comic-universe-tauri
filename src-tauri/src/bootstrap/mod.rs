mod app_paths;
mod system;

use std::sync::Arc;
use std::{
    collections::{HashMap, HashSet},
    error::Error,
    fs,
    io,
    path::{Path, PathBuf},
};

use app_paths::resolve_app_paths;
use serde_json::{json, Value};
#[cfg(target_os = "macos")]
use tauri::menu::Menu;
use tauri::{Emitter, Manager, RunEvent};
#[cfg(any(target_os = "linux", target_os = "windows"))]
use tauri_plugin_deep_link::DeepLinkExt;

use crate::{
    application::{AdminService, DocumentService, LibraryService},
    infrastructure::{FilesystemComicLibraryStore, SqliteDocumentStore},
    presentation::{start_rest_api, ApiEndpointPayload, RestApiState},
};

use self::system::resolve_machine_hostname;

struct ApiEndpointState(ApiEndpointPayload);

#[tauri::command]
fn get_machine_hostname() -> String {
    resolve_machine_hostname()
}

#[tauri::command]
fn get_runtime_platform() -> &'static str {
    std::env::consts::OS
}

#[tauri::command]
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn minimize_main_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    println!("[window] minimize_main_window invoked");
    window
        .minimize()
        .map_err(|error| {
            let message = format!("Failed to minimize main window: {error}");
            eprintln!("[window] {message}");
            message
        })?;

    println!("[window] minimize_main_window succeeded");
    Ok(())
}

#[tauri::command]
#[cfg(any(target_os = "android", target_os = "ios"))]
fn minimize_main_window(_app_handle: tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

fn boxed_error(message: String) -> Box<dyn Error> {
    Box::new(io::Error::other(message))
}

fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn Error>> {
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    {
        if let Err(error) = app.deep_link().register_all() {
            eprintln!("Failed to register deep-link schemes at runtime: {error}");
        }
    }

    #[cfg(target_os = "macos")]
    if let Some(main_window) = app.get_webview_window("main") {
        let default_menu = Menu::default(app.handle())
            .map_err(|e| boxed_error(format!("Failed to create macOS default menu: {e}")))?;
        app.set_menu(default_menu)
            .map_err(|e| boxed_error(format!("Failed to set macOS default menu: {e}")))?;

        main_window
            .set_minimizable(true)
            .map_err(|e| boxed_error(format!("Failed to enable minimize on macOS window: {e}")))?;
    }

    let paths = resolve_app_paths(app).map_err(boxed_error)?;
    println!("Active OS profile: {}", paths.profile);
    println!("Base data root: {}", paths.base_root.display());
    println!("Data root: {}", paths.root.display());
    println!("Database dir: {}", paths.database.display());
    println!("Comics dir: {}", paths.comics.display());
    println!("Settings dir: {}", paths.settings.display());
    println!("Wallpapers dir: {}", paths.wallpapers.display());

    let store = Arc::new(
        SqliteDocumentStore::initialize(&paths.database).map_err(|e| boxed_error(e.to_string()))?,
    );
    let service = DocumentService::new(store.clone());
    let admin_service = AdminService::new(store.clone());
    let library_store = std::sync::Arc::new(
        FilesystemComicLibraryStore::initialize(&paths.database, &paths.comics)
            .map_err(|e| boxed_error(e.to_string()))?,
    );
    let library_service = LibraryService::new(library_store);
    seed_default_plugins(&service)
        .map_err(|error| boxed_error(format!("Failed to seed default plugins: {error}")))?;
    sync_chapters_offline_status(&service, &paths.comics)
        .map_err(|error| boxed_error(format!("Failed to sync offline chapter status: {error}")))?;

    match start_rest_api(service, admin_service, library_service, paths.comics.clone()) {
        Ok(api) => {
            let endpoint = api.endpoint();
            println!(
                "REST API listening on {} (port {})",
                endpoint.base_url, endpoint.port
            );
            app.manage(ApiEndpointState(endpoint));
            app.manage(api);
        }
        Err(error) => {
            eprintln!("Failed to start REST API: {error}");
            app.handle().exit(1);
        }
    }

    Ok(())
}

fn seed_default_plugins(service: &DocumentService) -> Result<(), String> {
    let defaults = [
        (
            "plugin:anilist",
            json!({
                "enabled": true,
                "name": "AniList",
                "tag": "anilist",
                "endpoint": "https://comic-universe-plugin-anilist.vercel.app/api",
                "metadataUrl": "https://comic-universe-plugin-anilist.vercel.app/api/metadata",
                "contentTypes": ["manga", "comic"],
                "capabilities": ["metadata"],
                "languageCodes": ["en"],
                "sources": [
                    {
                        "id": "anilist",
                        "name": "AniList",
                        "languageCodes": ["en"],
                        "isDefault": true
                    }
                ]
            }),
        ),
        (
            "plugin:mangadex",
            json!({
                "enabled": true,
                "name": "MangaDex",
                "tag": "mangadex",
                "endpoint": "https://comic-universe-plugin-mangadex.vercel.app/api",
                "metadataUrl": "https://comic-universe-plugin-mangadex.vercel.app/api/metadata",
                "contentTypes": ["manga", "comic"],
                "capabilities": ["metadata", "content"],
                "features": {
                    "onDemandPageList": true
                },
                "languageCodes": ["en", "pt-br", "es-la", "es", "fr", "de", "it", "ru", "ja"],
                "sources": [
                    {
                        "id": "mangadex",
                        "name": "MangaDex",
                        "languageCodes": ["en", "pt-br", "es-la", "es", "fr", "de", "it", "ru", "ja"],
                        "isDefault": true
                    }
                ]
            }),
        ),
    ];

    for (id, data) in defaults {
        let exists = service.get("plugins", id).map_err(|e| e.to_string())?.is_some();
        if exists {
            continue;
        }

        service
            .upsert("plugins", Some(id.to_string()), data)
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn sync_chapters_offline_status(service: &DocumentService, comics_dir: &Path) -> Result<(), String> {
    let chapters = list_all_records(service, "chapters", 1000)?;
    let comics = list_all_records(service, "comics", 500)?;
    let mut comic_names = HashMap::new();
    for comic in comics {
        if let Some(name) = record_value_as_string(&comic.data, "name") {
            comic_names.insert(comic.id, name);
        }
    }

    let mut comic_dirs_cache: HashMap<String, Vec<PathBuf>> = HashMap::new();
    let mut checked = 0usize;
    let mut updated = 0usize;

    for chapter in chapters {
        checked += 1;
        let comic_id = match record_value_as_string(&chapter.data, "comicId") {
            Some(value) => value,
            None => continue,
        };
        let comic_name = comic_names
            .get(&comic_id)
            .cloned()
            .unwrap_or_else(|| comic_id.clone());
        let chapter_name = chapter_display_name(&chapter.data);
        let chapter_number = record_value_as_string(&chapter.data, "number");
        let has_local_cbz = chapter_has_local_cbz(
            comics_dir,
            &comic_id,
            &comic_name,
            &chapter_name,
            chapter_number.as_deref(),
            &mut comic_dirs_cache,
        );

        let current_has_offline = chapter
            .data
            .get("hasOffline")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let current_offline = chapter
            .data
            .get("offline")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            != 0;
        if current_has_offline == has_local_cbz && current_offline == has_local_cbz {
            continue;
        }

        let mut next_data = chapter.data.clone();
        if let Value::Object(ref mut map) = next_data {
            map.insert("hasOffline".to_string(), Value::Bool(has_local_cbz));
            map.insert(
                "offline".to_string(),
                Value::Number(serde_json::Number::from(if has_local_cbz { 1 } else { 0 })),
            );
        }

        service
            .upsert("chapters", Some(chapter.id), next_data)
            .map_err(|e| e.to_string())?;
        updated += 1;
    }

    println!(
        "Offline chapter status sync finished: checked {}, updated {}",
        checked, updated
    );

    Ok(())
}

fn list_all_records(
    service: &DocumentService,
    table_name: &str,
    page_size: u32,
) -> Result<Vec<crate::domain::DbRecord>, String> {
    let mut all = Vec::new();
    let mut offset = 0u32;
    loop {
        let batch = service
            .list(table_name, Some(page_size), Some(offset))
            .map_err(|e| e.to_string())?;
        if batch.is_empty() {
            break;
        }
        let batch_len = batch.len() as u32;
        all.extend(batch);
        if batch_len < page_size {
            break;
        }
        offset = offset.saturating_add(page_size);
    }
    Ok(all)
}

fn record_value_as_string(data: &Value, field: &str) -> Option<String> {
    data.get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
}

fn chapter_display_name(data: &Value) -> String {
    record_value_as_string(data, "name")
        .or_else(|| record_value_as_string(data, "number").map(|n| format!("Chapter {n}")))
        .unwrap_or_else(|| "chapter".to_string())
}

fn chapter_has_local_cbz(
    comics_dir: &Path,
    comic_id: &str,
    comic_name: &str,
    chapter_name: &str,
    chapter_number: Option<&str>,
    comic_dirs_cache: &mut HashMap<String, Vec<PathBuf>>,
) -> bool {
    let chapter_file_candidates = chapter_file_candidates(chapter_name, chapter_number);
    let dir_candidates = comic_dirs_cache
        .entry(comic_id.to_string())
        .or_insert_with(|| build_comic_dir_candidates(comics_dir, comic_id, comic_name));

    for dir in dir_candidates {
        for candidate in &chapter_file_candidates {
            if dir.join(candidate).is_file() {
                return true;
            }
        }
    }
    false
}

fn build_comic_dir_candidates(comics_dir: &Path, comic_id: &str, comic_name: &str) -> Vec<PathBuf> {
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
            if let Some(name) = path.file_name().and_then(|v| v.to_str()) {
                if name == comic_base || name.starts_with(&format!("{comic_base} (")) {
                    dir_candidates.push(path);
                }
            }
        }
    }

    let mut unique = HashSet::new();
    dir_candidates
        .into_iter()
        .filter(|path| unique.insert(path.clone()))
        .collect()
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

fn emit_endpoint_on_page_load(window: &tauri::Webview) {
    if let Some(endpoint_state) = window.app_handle().try_state::<ApiEndpointState>() {
        let _ = window.emit("api://endpoint", &endpoint_state.0);
    }
}

fn handle_run_event(app_handle: &tauri::AppHandle, event: RunEvent) {
    match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            if !has_visible_windows {
                if let Some(main_window) = app_handle.get_webview_window("main") {
                    let _ = main_window.show();
                    let _ = main_window.unminimize();
                    let _ = main_window.set_focus();
                }
            }
        }
        RunEvent::Exit => {
            if let Some(api) = app_handle.try_state::<RestApiState>() {
                api.stop();
            }
        }
        _ => {}
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .enable_macos_default_menu(true)
        .plugin(tauri_plugin_deep_link::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        if let Some(main_window) = app.get_webview_window("main") {
            let _ = main_window.show();
            let _ = main_window.unminimize();
            let _ = main_window.set_focus();
        }

        let deep_links = argv
            .iter()
            .filter(|arg| {
                arg.starts_with("comic-universe://") || arg.starts_with("comic-universe-tauri://")
            })
            .cloned()
            .collect::<Vec<String>>();

        if !deep_links.is_empty() {
            let _ = app.emit("deep-link://urls", deep_links);
        }
    }));

    let app = builder
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_machine_hostname,
            get_runtime_platform,
            minimize_main_window
        ])
        .setup(setup_app)
        .on_page_load(|window, _| emit_endpoint_on_page_load(window))
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(handle_run_event);
}
