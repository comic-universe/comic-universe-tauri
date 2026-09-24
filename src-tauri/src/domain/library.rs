use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComicCover {
    pub remote_url: Option<String>,
    pub local_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComicSource {
    pub plugin_id: Option<String>,
    pub plugin_tag: Option<String>,
    pub plugin_name: Option<String>,
    pub source_site_id: Option<String>,
    pub source_site_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComicPage {
    pub index: usize,
    pub file_name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct OfflineChapterFile {
    pub available: bool,
    pub cbz_file: Option<String>,
    pub page_count: Option<usize>,
    pub size_bytes: Option<u64>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChapterVariant {
    pub id: String,
    pub language: Option<String>,
    pub plugin_id: Option<String>,
    pub plugin_tag: Option<String>,
    pub plugin_name: Option<String>,
    pub chapter_site_id: Option<String>,
    pub chapter_site_url: Option<String>,
    #[serde(default)]
    pub pages: Vec<ComicPage>,
    pub offline: Option<OfflineChapterFile>,
    #[serde(default)]
    pub source_data: serde_json::Value,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComicChapter {
    pub id: String,
    pub number: String,
    pub sort_key: Option<f64>,
    pub title: Option<String>,
    #[serde(default)]
    pub title_by_language: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub available_languages: Vec<String>,
    #[serde(default)]
    pub variants: Vec<ChapterVariant>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComicMetadata {
    pub schema_version: u32,
    pub id: String,
    pub slug: String,
    pub title: String,
    pub description: Option<String>,
    pub publisher: Option<String>,
    pub status: Option<String>,
    pub content_type: Option<String>,
    pub cover: Option<ComicCover>,
    #[serde(default)]
    pub sources: Vec<ComicSource>,
    #[serde(default)]
    pub languages: Vec<String>,
    #[serde(default)]
    pub chapters: Vec<ComicChapter>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LibraryListItem {
    pub comic_id: String,
    pub slug: String,
    pub title: String,
    pub description_preview: Option<String>,
    pub cover_url: Option<String>,
    pub status: Option<String>,
    pub content_type: Option<String>,
    #[serde(default)]
    pub languages: Vec<String>,
    #[serde(default)]
    pub source_keys: Vec<String>,
    pub chapter_count: usize,
    pub offline_chapter_count: usize,
    pub metadata_path: String,
    pub updated_at: String,
}
