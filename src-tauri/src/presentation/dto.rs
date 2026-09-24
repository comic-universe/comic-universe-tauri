use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::domain::{ComicMetadata, LibraryListItem};

#[derive(Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApiEndpointPayload {
    pub host: String,
    pub port: u16,
    pub base_url: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpsertBody {
    pub id: Option<String>,
    pub data: Value,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FindBody {
    pub json_path: String,
    pub value: Value,
    pub limit: Option<u32>,
}

#[derive(Deserialize)]
pub struct ListQuery {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Serialize, ToSchema)]
pub struct HealthResponse {
    pub status: String,
}

#[derive(Serialize, ToSchema)]
pub struct DeleteResponse {
    pub deleted: bool,
}

#[derive(Serialize, ToSchema)]
pub struct ErrorResponse {
    pub message: String,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChapterPage {
    pub index: usize,
    pub file_name: String,
    pub url: String,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChapterPagesResponse {
    pub chapter_id: String,
    pub comic_id: String,
    pub comic_name: String,
    pub chapter_name: String,
    pub page_count: usize,
    pub pages: Vec<ChapterPage>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LibraryComicListResponse {
    #[serde(flatten)]
    pub item: LibraryListItem,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LibraryComicResponse {
    #[serde(flatten)]
    pub metadata: ComicMetadata,
}

#[derive(Deserialize, Default, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MigrateLegacyBody {
    pub legacy_db_path: Option<String>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MigrateLegacyResponse {
    pub performed: bool,
    pub imported_rows: usize,
    pub legacy_db_path: Option<String>,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarkChaptersBody {
    pub chapter_ids: Vec<String>,
    pub read: bool,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarkChaptersResponse {
    pub updated: usize,
    pub skipped: usize,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportComicBody {
    #[serde(default)]
    pub data: ImportComicData,
}

#[derive(Deserialize, Default, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportComicData {
    pub target_comic_id: Option<String>,
    #[serde(default)]
    pub comic: Value,
    #[serde(default)]
    pub chapters: Vec<Value>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportComicResponse {
    pub comic_id: String,
    pub chapters_imported: usize,
    pub chapters_skipped: usize,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SaveVariantPagesBody {
    pub variant_id: String,
    pub canonical_chapter_id: Option<String>,
    pub plugin_id: Option<String>,
    pub plugin_tag: Option<String>,
    pub plugin_name: Option<String>,
    pub chapter_site_id: Option<String>,
    pub chapter_site_url: Option<String>,
    pub language: Option<String>,
    #[serde(default)]
    pub language_codes: Vec<String>,
    pub name: Option<String>,
    #[serde(default)]
    pub pages: Vec<crate::domain::ComicPage>,
    #[serde(default)]
    pub source_data: Value,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DownloadOfflineChaptersBody {
    pub variant_ids: Vec<String>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DownloadOfflineChaptersResponse {
    pub comic_id: String,
    pub requested: usize,
    pub downloaded: usize,
    pub skipped: usize,
    pub failed: usize,
}
