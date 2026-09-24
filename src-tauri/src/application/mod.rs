mod library;

use std::sync::Arc;

use serde_json::Value;

use crate::domain::{AppError, DbRecord, LegacyImportReport, Table};
pub use library::{ComicLibraryStore, LibraryService};

pub trait DocumentStore: Send + Sync {
    fn upsert(&self, table: Table, id: Option<String>, data: Value) -> Result<DbRecord, AppError>;
    fn get(&self, table: Table, id: &str) -> Result<Option<DbRecord>, AppError>;
    fn list(
        &self,
        table: Table,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<Vec<DbRecord>, AppError>;
    fn find_by_json_field(
        &self,
        table: Table,
        json_path: &str,
        value: Value,
        limit: Option<u32>,
    ) -> Result<Vec<DbRecord>, AppError>;
    fn delete(&self, table: Table, id: &str) -> Result<bool, AppError>;
    fn mark_chapters_read_state(
        &self,
        chapter_ids: &[String],
        read: bool,
    ) -> Result<(usize, usize), AppError>;
}

pub trait LegacyImporter: Send + Sync {
    fn import_legacy(
        &self,
        legacy_db_path: Option<String>,
    ) -> Result<Option<LegacyImportReport>, AppError>;
}

#[derive(Clone)]
pub struct DocumentService {
    store: Arc<dyn DocumentStore>,
}

impl DocumentService {
    pub fn new(store: Arc<dyn DocumentStore>) -> Self {
        Self { store }
    }

    pub fn upsert(
        &self,
        table_name: &str,
        id: Option<String>,
        data: Value,
    ) -> Result<DbRecord, AppError> {
        let table = Table::parse(table_name)?;
        self.store.upsert(table, id, data)
    }

    pub fn get(&self, table_name: &str, id: &str) -> Result<Option<DbRecord>, AppError> {
        let table = Table::parse(table_name)?;
        self.store.get(table, id)
    }

    pub fn list(
        &self,
        table_name: &str,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<Vec<DbRecord>, AppError> {
        let table = Table::parse(table_name)?;
        self.store.list(table, limit, offset)
    }

    pub fn find_by_json_field(
        &self,
        table_name: &str,
        json_path: &str,
        value: Value,
        limit: Option<u32>,
    ) -> Result<Vec<DbRecord>, AppError> {
        let table = Table::parse(table_name)?;
        self.store
            .find_by_json_field(table, json_path, value, limit)
    }

    pub fn delete(&self, table_name: &str, id: &str) -> Result<bool, AppError> {
        let table = Table::parse(table_name)?;
        self.store.delete(table, id)
    }

    pub fn mark_chapters_read_state(
        &self,
        chapter_ids: &[String],
        read: bool,
    ) -> Result<(usize, usize), AppError> {
        self.store.mark_chapters_read_state(chapter_ids, read)
    }
}

#[derive(Clone)]
pub struct AdminService {
    importer: Arc<dyn LegacyImporter>,
}

impl AdminService {
    pub fn new(importer: Arc<dyn LegacyImporter>) -> Self {
        Self { importer }
    }

    pub fn migrate_legacy(
        &self,
        legacy_db_path: Option<String>,
    ) -> Result<Option<LegacyImportReport>, AppError> {
        self.importer.import_legacy(legacy_db_path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::DbRecord;
    use std::sync::{Arc, Mutex};

    struct MockStore {
        calls: Mutex<Vec<String>>,
    }

    impl MockStore {
        fn new() -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
            }
        }
    }

    impl DocumentStore for MockStore {
        fn upsert(
            &self,
            table: Table,
            id: Option<String>,
            data: Value,
        ) -> Result<DbRecord, AppError> {
            self.calls
                .lock()
                .expect("poisoned")
                .push(format!("upsert:{}", table.as_str()));
            Ok(DbRecord {
                id: id.unwrap_or_else(|| "generated".to_string()),
                data,
                created_at: "2026-01-01T00:00:00.000Z".to_string(),
                updated_at: "2026-01-01T00:00:00.000Z".to_string(),
            })
        }

        fn get(&self, table: Table, id: &str) -> Result<Option<DbRecord>, AppError> {
            self.calls
                .lock()
                .expect("poisoned")
                .push(format!("get:{}:{id}", table.as_str()));
            Ok(None)
        }

        fn list(
            &self,
            table: Table,
            _limit: Option<u32>,
            _offset: Option<u32>,
        ) -> Result<Vec<DbRecord>, AppError> {
            self.calls
                .lock()
                .expect("poisoned")
                .push(format!("list:{}", table.as_str()));
            Ok(Vec::new())
        }

        fn find_by_json_field(
            &self,
            table: Table,
            _json_path: &str,
            _value: Value,
            _limit: Option<u32>,
        ) -> Result<Vec<DbRecord>, AppError> {
            self.calls
                .lock()
                .expect("poisoned")
                .push(format!("find:{}", table.as_str()));
            Ok(Vec::new())
        }

        fn delete(&self, table: Table, id: &str) -> Result<bool, AppError> {
            self.calls
                .lock()
                .expect("poisoned")
                .push(format!("delete:{}:{id}", table.as_str()));
            Ok(true)
        }

        fn mark_chapters_read_state(
            &self,
            _chapter_ids: &[String],
            _read: bool,
        ) -> Result<(usize, usize), AppError> {
            self.calls
                .lock()
                .expect("poisoned")
                .push("mark:chapters".to_string());
            Ok((0, 0))
        }
    }

    #[test]
    fn rejects_unknown_table() {
        let service = DocumentService::new(Arc::new(MockStore::new()));
        let result = service.list("unknown", None, None);
        assert!(matches!(result, Err(AppError::InvalidTable(_))));
    }

    #[test]
    fn forwards_valid_table_to_store() {
        let store = Arc::new(MockStore::new());
        let service = DocumentService::new(store.clone());
        let result = service.upsert("comics", None, serde_json::json!({ "name": "Pablo" }));
        assert!(result.is_ok());
        let calls = store.calls.lock().expect("poisoned");
        assert!(calls.iter().any(|value| value == "upsert:comics"));
    }
}
