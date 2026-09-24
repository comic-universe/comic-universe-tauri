use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension};

use crate::{
    application::ComicLibraryStore,
    domain::{AppError, ChapterVariant, ComicMetadata, LibraryListItem},
};

const INDEX_SCHEMA_VERSION: &str = "1";

pub struct FilesystemComicLibraryStore {
    comics_dir: PathBuf,
    index_db_path: PathBuf,
    sync_lock: Mutex<()>,
}

impl FilesystemComicLibraryStore {
    pub fn initialize(database_dir: &Path, comics_dir: &Path) -> Result<Self, AppError> {
        fs::create_dir_all(database_dir).map_err(|e| AppError::infrastructure(e.to_string()))?;
        fs::create_dir_all(comics_dir).map_err(|e| AppError::infrastructure(e.to_string()))?;
        let index_db_path = database_dir.join("library_index.db");
        let conn = open_index_connection(&index_db_path)?;
        ensure_index_schema(&conn)?;
        Ok(Self {
            comics_dir: comics_dir.to_path_buf(),
            index_db_path,
            sync_lock: Mutex::new(()),
        })
    }

    fn load_metadata(&self, metadata_path: &Path) -> Result<ComicMetadata, AppError> {
        let raw = fs::read_to_string(metadata_path)
            .map_err(|e| AppError::infrastructure(format!("Failed to read {}: {e}", metadata_path.display())))?;
        let metadata: ComicMetadata = serde_json::from_str(&raw).map_err(|e| {
            AppError::Validation(format!("Invalid metadata file {}: {e}", metadata_path.display()))
        })?;
        if metadata.id.trim().is_empty() || metadata.slug.trim().is_empty() || metadata.title.trim().is_empty() {
            return Err(AppError::Validation(format!(
                "Metadata file {} is missing id/slug/title",
                metadata_path.display()
            )));
        }
        Ok(metadata)
    }

    fn cache_cover_if_needed(&self, comic_dir: &Path, comic: &mut ComicMetadata) -> Result<(), AppError> {
        let Some(cover) = comic.cover.as_mut() else {
            return Ok(());
        };
        let local_exists = cover
            .local_file
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| comic_dir.join(value))
            .is_some_and(|path| path.is_file());
        if local_exists {
            return Ok(());
        }

        let Some(remote_url) = cover
            .remote_url
            .as_deref()
            .map(str::trim)
            .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
        else {
            return Ok(());
        };

        let agent = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(20))
            .timeout_read(std::time::Duration::from_secs(20))
            .build();
        let response = agent
            .get(remote_url)
            .call()
            .map_err(|e| AppError::infrastructure(format!("Failed to download cover from {remote_url}: {e}")))?;
        let status = response.status();
        if !(200..300).contains(&status) {
            return Err(AppError::infrastructure(format!(
                "Failed to download cover from {remote_url}: HTTP {}",
                status
            )));
        }

        let content_type = response.header("content-type").map(str::to_string);
        let mut reader = response.into_reader();
        let mut bytes = Vec::new();
        reader
            .read_to_end(&mut bytes)
            .map_err(|e| AppError::infrastructure(format!("Failed to read cover response body: {e}")))?;
        if bytes.is_empty() {
            return Err(AppError::infrastructure(format!(
                "Failed to download cover from {remote_url}: empty body"
            )));
        }

        let extension = infer_cover_extension(remote_url, content_type.as_deref());
        let file_name = format!("cover.{extension}");
        let target_path = comic_dir.join(&file_name);
        fs::write(&target_path, &bytes)
            .map_err(|e| AppError::infrastructure(format!("Failed to write {}: {e}", target_path.display())))?;
        cover.local_file = Some(file_name);
        Ok(())
    }

    fn compute_fingerprint(&self, comic_dir: &Path, metadata_path: &Path) -> Result<String, AppError> {
        let mut pieces = Vec::new();
        append_file_fingerprint(&mut pieces, metadata_path)?;
        let chapters_dir = comic_dir.join("chapters");
        if chapters_dir.is_dir() {
            let mut chapter_entries = fs::read_dir(&chapters_dir)
                .map_err(|e| AppError::infrastructure(format!("Failed to read {}: {e}", chapters_dir.display())))?
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.is_file())
                .collect::<Vec<_>>();
            chapter_entries.sort();
            for path in chapter_entries {
                append_file_fingerprint(&mut pieces, &path)?;
            }
        }
        let mut hasher = DefaultHasher::new();
        pieces.hash(&mut hasher);
        Ok(format!("{:x}", hasher.finish()))
    }

    fn upsert_index_record(
        &self,
        conn: &Connection,
        metadata_path: &Path,
        comic_dir: &Path,
        metadata: &ComicMetadata,
        fingerprint: &str,
    ) -> Result<(), AppError> {
        let cover_path = metadata
            .cover
            .as_ref()
            .and_then(|cover| cover.local_file.as_ref())
            .map(|file| comic_dir.join(file))
            .filter(|path| path.is_file())
            .map(|path| path.to_string_lossy().to_string());
        let cover_url = cover_path.or_else(|| metadata.cover.as_ref().and_then(|cover| cover.remote_url.clone()));
        let description_preview = metadata
            .description
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| {
                if value.chars().count() > 240 {
                    value.chars().take(240).collect::<String>()
                } else {
                    value.to_string()
                }
            });
        let offline_chapter_count = metadata
            .chapters
            .iter()
            .filter(|chapter| {
                chapter
                    .variants
                    .iter()
                    .any(|variant| variant.offline.as_ref().and_then(|entry| entry.cbz_file.as_ref()).is_some())
            })
            .count() as i64;
        let languages_json = serde_json::to_string(&metadata.languages)
            .map_err(|e| AppError::infrastructure(e.to_string()))?;
        let source_keys_json = serde_json::to_string(
            &metadata
                .sources
                .iter()
                .filter_map(|source| match (&source.plugin_tag, &source.source_site_id) {
                    (Some(tag), Some(site_id)) if !tag.trim().is_empty() && !site_id.trim().is_empty() => {
                        Some(format!("{}:{}", tag.trim(), site_id.trim()))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>(),
        )
        .map_err(|e| AppError::infrastructure(e.to_string()))?;
        conn.execute(
            "INSERT INTO comics_index (
                comic_id, slug, title, normalized_title, folder_path, metadata_path, cover_path,
                description_preview, content_type, status, languages_json, source_keys_json, chapter_count,
                offline_chapter_count, fingerprint, metadata_mtime, indexed_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
             ON CONFLICT(comic_id) DO UPDATE SET
                slug = excluded.slug,
                title = excluded.title,
                normalized_title = excluded.normalized_title,
                folder_path = excluded.folder_path,
                metadata_path = excluded.metadata_path,
                cover_path = excluded.cover_path,
                description_preview = excluded.description_preview,
                content_type = excluded.content_type,
                status = excluded.status,
                languages_json = excluded.languages_json,
                source_keys_json = excluded.source_keys_json,
                chapter_count = excluded.chapter_count,
                offline_chapter_count = excluded.offline_chapter_count,
                fingerprint = excluded.fingerprint,
                metadata_mtime = excluded.metadata_mtime,
                indexed_at = excluded.indexed_at,
                updated_at = excluded.updated_at",
            params![
                metadata.id,
                metadata.slug,
                metadata.title,
                normalize_title(&metadata.title),
                comic_dir.to_string_lossy().to_string(),
                metadata_path.to_string_lossy().to_string(),
                cover_url,
                description_preview,
                metadata.content_type,
                metadata.status,
                languages_json,
                source_keys_json,
                metadata.chapters.len() as i64,
                offline_chapter_count,
                fingerprint,
                file_modified_string(metadata_path)?,
                now_string(),
                metadata.updated_at
            ],
        )
        .map_err(|e| AppError::infrastructure(e.to_string()))?;
        Ok(())
    }
}

impl ComicLibraryStore for FilesystemComicLibraryStore {
    fn sync_index(&self) -> Result<(), AppError> {
        let _guard = self
            .sync_lock
            .lock()
            .map_err(|_| AppError::infrastructure("Library sync lock poisoned".to_string()))?;
        let conn = open_index_connection(&self.index_db_path)?;
        ensure_index_schema(&conn)?;

        let mut seen_ids = Vec::new();
        let entries = fs::read_dir(&self.comics_dir)
            .map_err(|e| AppError::infrastructure(format!("Failed to read {}: {e}", self.comics_dir.display())))?;

        for entry in entries.flatten() {
            let comic_dir = entry.path();
            if !comic_dir.is_dir() {
                continue;
            }
            let metadata_path = comic_dir.join("metadata.json");
            if !metadata_path.is_file() {
                continue;
            }

            let metadata = match self.load_metadata(&metadata_path) {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("{error}");
                    continue;
                }
            };
            let fingerprint = self.compute_fingerprint(&comic_dir, &metadata_path)?;
            self.upsert_index_record(&conn, &metadata_path, &comic_dir, &metadata, &fingerprint)?;
            seen_ids.push(metadata.id);
        }

        let mut stmt = conn
            .prepare("SELECT comic_id, folder_path FROM comics_index")
            .map_err(|e| AppError::infrastructure(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| AppError::infrastructure(e.to_string()))?;
        for row in rows {
            let (comic_id, folder_path) = row.map_err(|e| AppError::infrastructure(e.to_string()))?;
            if seen_ids.iter().any(|seen| seen == &comic_id) && Path::new(&folder_path).is_dir() {
                continue;
            }
            conn.execute("DELETE FROM comics_index WHERE comic_id = ?1", params![comic_id])
                .map_err(|e| AppError::infrastructure(e.to_string()))?;
        }

        conn.execute(
            "INSERT INTO meta(key, value) VALUES ('last_scan_at', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![now_string()],
        )
        .map_err(|e| AppError::infrastructure(e.to_string()))?;

        Ok(())
    }

    fn list_comics(&self) -> Result<Vec<LibraryListItem>, AppError> {
        let conn = open_index_connection(&self.index_db_path)?;
        let mut stmt = conn
            .prepare(
                "SELECT comic_id, slug, title, description_preview, cover_path, status, content_type,
                        languages_json, source_keys_json, chapter_count, offline_chapter_count, metadata_path, updated_at
                 FROM comics_index
                 ORDER BY normalized_title ASC",
            )
            .map_err(|e| AppError::infrastructure(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                let languages_json: String = row.get(7)?;
                let languages: Vec<String> = serde_json::from_str(&languages_json).unwrap_or_default();
                let source_keys_json: String = row.get(8)?;
                let source_keys: Vec<String> = serde_json::from_str(&source_keys_json).unwrap_or_default();
                Ok(LibraryListItem {
                    comic_id: row.get(0)?,
                    slug: row.get(1)?,
                    title: row.get(2)?,
                    description_preview: row.get(3)?,
                    cover_url: row.get(4)?,
                    status: row.get(5)?,
                    content_type: row.get(6)?,
                    languages,
                    source_keys,
                    chapter_count: row.get::<_, i64>(9)?.max(0) as usize,
                    offline_chapter_count: row.get::<_, i64>(10)?.max(0) as usize,
                    metadata_path: row.get(11)?,
                    updated_at: row.get(12)?,
                })
            })
            .map_err(|e| AppError::infrastructure(e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::infrastructure(e.to_string()))
    }

    fn get_comic(&self, comic_id: &str) -> Result<Option<ComicMetadata>, AppError> {
        let conn = open_index_connection(&self.index_db_path)?;
        let metadata_path: Option<String> = conn
            .query_row(
                "SELECT metadata_path FROM comics_index WHERE comic_id = ?1 LIMIT 1",
                params![comic_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| AppError::infrastructure(e.to_string()))?;
        match metadata_path {
            Some(path) => self.load_metadata(Path::new(&path)).map(Some),
            None => Ok(None),
        }
    }

    fn save_comic(&self, comic: &ComicMetadata) -> Result<(), AppError> {
        let _guard = self
            .sync_lock
            .lock()
            .map_err(|_| AppError::infrastructure("Library sync lock poisoned".to_string()))?;
        let folder_name = sanitize_slug(&comic.slug);
        let comic_dir = self.comics_dir.join(folder_name);
        fs::create_dir_all(comic_dir.join("chapters"))
            .map_err(|e| AppError::infrastructure(e.to_string()))?;
        let mut persisted_comic = comic.clone();
        if let Err(error) = self.cache_cover_if_needed(&comic_dir, &mut persisted_comic) {
            eprintln!("{error}");
        }
        let metadata_path = comic_dir.join("metadata.json");
        let payload = serde_json::to_string_pretty(&persisted_comic)
            .map_err(|e| AppError::infrastructure(e.to_string()))?;
        fs::write(&metadata_path, payload)
            .map_err(|e| AppError::infrastructure(format!("Failed to write {}: {e}", metadata_path.display())))?;
        drop(_guard);
        self.sync_index()
    }

    fn delete_comic(&self, comic_id: &str) -> Result<bool, AppError> {
        let conn = open_index_connection(&self.index_db_path)?;
        let folder_path: Option<String> = conn
            .query_row(
                "SELECT folder_path FROM comics_index WHERE comic_id = ?1 LIMIT 1",
                params![comic_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| AppError::infrastructure(e.to_string()))?;
        let Some(folder_path) = folder_path else {
            return Ok(false);
        };
        fs::remove_dir_all(&folder_path)
            .map_err(|e| AppError::infrastructure(format!("Failed to remove {folder_path}: {e}")))?;
        conn.execute("DELETE FROM comics_index WHERE comic_id = ?1", params![comic_id])
            .map_err(|e| AppError::infrastructure(e.to_string()))?;
        Ok(true)
    }
}

fn open_index_connection(path: &Path) -> Result<Connection, AppError> {
    Connection::open(path).map_err(|e| AppError::infrastructure(e.to_string()))
}

fn ensure_index_schema(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS comics_index (
            comic_id TEXT PRIMARY KEY NOT NULL,
            slug TEXT NOT NULL,
            title TEXT NOT NULL,
            normalized_title TEXT NOT NULL,
            folder_path TEXT NOT NULL,
            metadata_path TEXT NOT NULL,
            cover_path TEXT,
            description_preview TEXT,
            content_type TEXT,
            status TEXT,
            languages_json TEXT NOT NULL,
            source_keys_json TEXT NOT NULL DEFAULT '[]',
            chapter_count INTEGER NOT NULL DEFAULT 0,
            offline_chapter_count INTEGER NOT NULL DEFAULT 0,
            fingerprint TEXT NOT NULL,
            metadata_mtime TEXT,
            indexed_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_comics_index_title ON comics_index(normalized_title);
        CREATE INDEX IF NOT EXISTS idx_comics_index_slug ON comics_index(slug);",
    )
    .map_err(|e| AppError::infrastructure(e.to_string()))?;

    let current_version: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = 'schema_version' LIMIT 1", [], |row| row.get(0))
        .optional()
        .map_err(|e| AppError::infrastructure(e.to_string()))?;
    if current_version.as_deref() != Some(INDEX_SCHEMA_VERSION) {
        conn.execute("DELETE FROM comics_index", [])
            .map_err(|e| AppError::infrastructure(e.to_string()))?;
        conn.execute(
            "INSERT INTO meta(key, value) VALUES ('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![INDEX_SCHEMA_VERSION],
        )
        .map_err(|e| AppError::infrastructure(e.to_string()))?;
    }
    Ok(())
}

fn append_file_fingerprint(pieces: &mut Vec<String>, path: &Path) -> Result<(), AppError> {
    let metadata = fs::metadata(path).map_err(|e| AppError::infrastructure(e.to_string()))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs().to_string())
        .unwrap_or_default();
    pieces.push(format!(
        "{}:{}:{}",
        path.file_name().and_then(|value| value.to_str()).unwrap_or_default(),
        metadata.len(),
        modified
    ));
    Ok(())
}

fn normalize_title(value: &str) -> String {
    value.trim().to_lowercase()
}

fn infer_cover_extension(remote_url: &str, content_type: Option<&str>) -> &'static str {
    if let Some(value) = content_type.map(|value| value.trim().to_ascii_lowercase()) {
        if value.contains("image/png") {
            return "png";
        }
        if value.contains("image/webp") {
            return "webp";
        }
        if value.contains("image/avif") {
            return "avif";
        }
        if value.contains("image/gif") {
            return "gif";
        }
        if value.contains("image/jpeg") || value.contains("image/jpg") {
            return "jpg";
        }
    }

    let path = remote_url.split('?').next().unwrap_or(remote_url);
    match Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "png",
        Some("webp") => "webp",
        Some("avif") => "avif",
        Some("gif") => "gif",
        Some("jpg") | Some("jpeg") => "jpg",
        _ => "jpg",
    }
}

fn now_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn file_modified_string(path: &Path) -> Result<String, AppError> {
    let metadata = fs::metadata(path).map_err(|e| AppError::infrastructure(e.to_string()))?;
    Ok(metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs().to_string())
        .unwrap_or_default())
}

pub fn resolve_variant_cbz_path(comics_dir: &Path, comic: &ComicMetadata, variant: &ChapterVariant) -> Option<PathBuf> {
    let relative = variant
        .offline
        .as_ref()
        .and_then(|entry| entry.cbz_file.as_deref())
        .filter(|value| !value.trim().is_empty())?;
    let candidate = comics_dir.join(&comic.slug).join(relative);
    if candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

pub fn build_variant_cbz_relative_path_from_parts(
    comic_slug: &str,
    chapter_number: &str,
    language: Option<&str>,
    plugin_tag: Option<&str>,
    plugin_id: Option<&str>,
) -> String {
    let comic_slug = sanitize_slug(comic_slug);
    let chapter_token = chapter_number_token(chapter_number);
    let language = sanitize_slug(language.unwrap_or("unknown"));
    let plugin = sanitize_slug(plugin_tag.or(plugin_id).unwrap_or("offline"));
    format!("chapters/{comic_slug}-ch-{chapter_token}-{language}-{plugin}.cbz")
}

fn sanitize_slug(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if matches!(ch, '-' | '_') {
            out.push('-');
        } else if ch.is_whitespace() {
            out.push('-');
        }
    }
    let cleaned = out.trim_matches('-').replace("--", "-");
    if cleaned.is_empty() {
        "comic".to_string()
    } else {
        cleaned
    }
}

fn chapter_number_token(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "0000".to_string();
    }

    if let Ok(integer) = trimmed.parse::<u32>() {
        return format!("{integer:04}");
    }

    if let Ok(decimal) = trimmed.replace(',', ".").parse::<f64>() {
        if decimal.fract() == 0.0 {
            return format!("{decimal:.0}")
                .parse::<u32>()
                .map(|value| format!("{value:04}"))
                .unwrap_or_else(|_| sanitize_slug(trimmed));
        }

        let normalized = trimmed.replace(',', ".");
        let mut token = sanitize_slug(&normalized);
        if token.is_empty() {
            token = "0000".to_string();
        }
        return token;
    }

    let token = sanitize_slug(trimmed);
    if token.is_empty() {
        "0000".to_string()
    } else {
        token
    }
}
