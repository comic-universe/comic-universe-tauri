use std::sync::Arc;

use crate::domain::{AppError, ChapterVariant, ComicMetadata, LibraryListItem};

pub trait ComicLibraryStore: Send + Sync {
    fn sync_index(&self) -> Result<(), AppError>;
    fn list_comics(&self) -> Result<Vec<LibraryListItem>, AppError>;
    fn get_comic(&self, comic_id: &str) -> Result<Option<ComicMetadata>, AppError>;
    fn save_comic(&self, comic: &ComicMetadata) -> Result<(), AppError>;
    fn delete_comic(&self, comic_id: &str) -> Result<bool, AppError>;
}

#[derive(Clone)]
pub struct LibraryService {
    store: Arc<dyn ComicLibraryStore>,
}

impl LibraryService {
    pub fn new(store: Arc<dyn ComicLibraryStore>) -> Self {
        Self { store }
    }

    pub fn list_comics(&self) -> Result<Vec<LibraryListItem>, AppError> {
        self.store.sync_index()?;
        self.store.list_comics()
    }

    pub fn get_comic(&self, comic_id: &str) -> Result<Option<ComicMetadata>, AppError> {
        self.store.sync_index()?;
        self.store.get_comic(comic_id)
    }

    pub fn save_comic(&self, comic: &ComicMetadata) -> Result<(), AppError> {
        self.store.save_comic(comic)?;
        self.store.sync_index()
    }

    pub fn delete_comic(&self, comic_id: &str) -> Result<bool, AppError> {
        self.store.delete_comic(comic_id)
    }

    pub fn resolve_pages(
        &self,
        comic_id: &str,
        chapter_id: &str,
        preferred_languages: &[String],
    ) -> Result<Option<(ComicMetadata, crate::domain::ComicChapter, ChapterVariant)>, AppError> {
        let Some(comic) = self.get_comic(comic_id)? else {
            return Ok(None);
        };
        let Some(chapter) = comic.chapters.iter().find(|entry| entry.id == chapter_id).cloned() else {
            return Ok(None);
        };
        let Some(variant) = select_variant(&chapter.variants, preferred_languages) else {
            return Ok(None);
        };
        Ok(Some((comic, chapter, variant)))
    }
}

fn normalize_language(value: &str) -> String {
    value.trim().to_lowercase().replace('_', "-")
}

fn language_rank(language: &str, preferred_languages: &[String]) -> usize {
    if preferred_languages.is_empty() {
        return usize::MAX;
    }

    let normalized = normalize_language(language);
    let base = normalized.split('-').next().unwrap_or_default().to_string();
    preferred_languages
        .iter()
        .enumerate()
        .map(|(index, preferred)| {
            let preferred_normalized = normalize_language(preferred);
            let preferred_base = preferred_normalized
                .split('-')
                .next()
                .unwrap_or_default()
                .to_string();
            let score = if normalized == preferred_normalized {
                0
            } else if base == preferred_normalized {
                1
            } else if normalized == preferred_base {
                2
            } else if base == preferred_base {
                3
            } else {
                usize::MAX / 2
            };
            index.saturating_mul(10).saturating_add(score)
        })
        .min()
        .unwrap_or(usize::MAX)
}

fn select_variant(variants: &[ChapterVariant], preferred_languages: &[String]) -> Option<ChapterVariant> {
    let mut sorted = variants.to_vec();
    sorted.sort_by(|left, right| {
        let left_rank = left
            .language
            .as_deref()
            .map(|value| language_rank(value, preferred_languages))
            .unwrap_or(usize::MAX);
        let right_rank = right
            .language
            .as_deref()
            .map(|value| language_rank(value, preferred_languages))
            .unwrap_or(usize::MAX);
        left_rank
            .cmp(&right_rank)
            .then_with(|| right.pages.len().cmp(&left.pages.len()))
            .then_with(|| left.id.cmp(&right.id))
    });
    sorted.into_iter().next()
}
