const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, '');

const API_BASE_URL_STORAGE_KEY = "comic-universe:api-base-url";

const defaultApiBaseUrl = normalizeBaseUrl(
  import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8787/api",
);

const readPersistedApiBaseUrl = (): string => {
  if (typeof window === "undefined") return defaultApiBaseUrl;

  const globalValue = (window as Window & { __CU_API_BASE_URL__?: string }).__CU_API_BASE_URL__;
  if (typeof globalValue === "string" && globalValue.trim()) {
    return normalizeBaseUrl(globalValue);
  }

  const storedValue = window.localStorage.getItem(API_BASE_URL_STORAGE_KEY);
  if (typeof storedValue === "string" && storedValue.trim()) {
    return normalizeBaseUrl(storedValue);
  }

  return defaultApiBaseUrl;
};

const persistApiBaseUrl = (value: string): void => {
  if (typeof window === "undefined") return;
  (window as Window & { __CU_API_BASE_URL__?: string }).__CU_API_BASE_URL__ = value;
  window.localStorage.setItem(API_BASE_URL_STORAGE_KEY, value);
};

let runtimeApiBaseUrl = readPersistedApiBaseUrl();

export type DbTable =
  | "comics"
  | "chapters"
  | "read_progress"
  | "plugins"
  | "changelog"
  | "app_state"
  | "works"
  | "canonical_chapters"
  | "chapter_variants"
  | "chapter_mappings";

export interface DbRecord<T = Record<string, unknown>> {
  id: string;
  data: T;
  created_at: string;
  updated_at: string;
}

export interface MigrateLegacyResponse {
  performed: boolean;
  importedRows: number;
  legacyDbPath?: string;
}

export interface ChapterPage {
  index: number;
  fileName: string;
  url: string;
}

export interface ChapterPagesResponse {
  chapterId: string;
  comicId: string;
  comicName: string;
  chapterName: string;
  pageCount: number;
  pages: ChapterPage[];
}

export interface LibraryListItem {
  comicId: string
  slug: string
  title: string
  descriptionPreview?: string | null
  coverUrl?: string | null
  status?: string | null
  contentType?: string | null
  languages: string[]
  sourceKeys: string[]
  chapterCount: number
  offlineChapterCount: number
  metadataPath: string
  updatedAt: string
}

export interface MarkChaptersPayload {
  chapterIds: string[];
  read: boolean;
}

export interface MarkChaptersResponse {
  updated: number;
  skipped: number;
}

export interface ImportComicPayload {
  data: {
    targetComicId?: string
    comic: Record<string, unknown>
    chapters: Array<Record<string, unknown>>
  }
}

export interface ImportComicResponse {
  comicId: string
  chaptersImported: number
  chaptersSkipped: number
}

export interface DownloadOfflineChaptersPayload {
  variantIds: string[]
}

export interface DownloadOfflineChaptersResponse {
  comicId: string
  requested: number
  downloaded: number
  skipped: number
  failed: number
}

export interface ComicData {
  name?: string;
  synopsis?: string;
  hasOffline?: boolean;
  [key: string]: unknown;
}

export interface ChapterData {
  comicId?: string;
  name?: string;
  number?: string;
  hasOffline?: number | boolean;
  [key: string]: unknown;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 4000);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      ...init,
      signal: init?.signal ?? controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("REST request timed out");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`REST request failed (${response.status}): ${text}`);
  }

  return JSON.parse(text) as T;
}

export async function apiHealthCheck(): Promise<string> {
  const payload = await requestJson<{ status: string }>(`${runtimeApiBaseUrl}/health`);
  return payload.status;
}

export async function dbUpsert<T extends Record<string, unknown>>(
  table: DbTable,
  data: T,
  id?: string,
): Promise<DbRecord<T>> {
  return requestJson<DbRecord<T>>(`${runtimeApiBaseUrl}/db/${table}`, {
    method: "POST",
    body: JSON.stringify({ id, data }),
  });
}

export async function dbFind<T extends Record<string, unknown>>(
  table: DbTable,
  jsonPath: string,
  value: unknown,
  limit?: number,
): Promise<Array<DbRecord<T>>> {
  return requestJson<Array<DbRecord<T>>>(`${runtimeApiBaseUrl}/db/${table}/find`, {
    method: "POST",
    body: JSON.stringify({ jsonPath, value, limit }),
  });
}

export async function dbGet<T extends Record<string, unknown>>(
  table: DbTable,
  id: string,
): Promise<DbRecord<T> | null> {
  try {
    return await requestJson<DbRecord<T>>(`${runtimeApiBaseUrl}/db/${table}/${id}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("(404)")) {
      return null;
    }
    throw error;
  }
}

export async function dbDelete(
  table: DbTable,
  id: string,
): Promise<{ deleted: boolean }> {
  return requestJson<{ deleted: boolean }>(`${runtimeApiBaseUrl}/db/${table}/${id}`, {
    method: "DELETE",
  });
}

export async function dbList<T extends Record<string, unknown>>(
  table: DbTable,
  limit = 200,
  offset = 0,
): Promise<Array<DbRecord<T>>> {
  return requestJson<Array<DbRecord<T>>>(
    `${runtimeApiBaseUrl}/db/${table}?limit=${limit}&offset=${offset}`,
  );
}

export async function listComics(): Promise<Array<DbRecord<ComicData>>> {
  return dbList<ComicData>("comics", 500, 0);
}

export async function listChaptersByComicId(
  comicId: string,
): Promise<Array<DbRecord<ChapterData>>> {
  return dbFind<ChapterData>("chapters", "comicId", comicId, 2000);
}

export async function migrateLegacyDatabase(
  legacyDbPath?: string,
): Promise<MigrateLegacyResponse> {
  return requestJson<MigrateLegacyResponse>(`${runtimeApiBaseUrl}/admin/migrate-legacy`, {
    method: "POST",
    body: JSON.stringify({ legacyDbPath }),
  });
}

export async function getChapterPages(chapterId: string): Promise<ChapterPagesResponse> {
  return requestJson<ChapterPagesResponse>(`${runtimeApiBaseUrl}/chapters/${chapterId}/pages`);
}

export async function markChaptersReadState(
  payload: MarkChaptersPayload,
): Promise<MarkChaptersResponse> {
  return requestJson<MarkChaptersResponse>(`${runtimeApiBaseUrl}/chapters/mark`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function listLibraryComics(): Promise<LibraryListItem[]> {
  return requestJson<LibraryListItem[]>(`${runtimeApiBaseUrl}/library`)
}

export async function getLibraryComic<T>(comicId: string): Promise<T> {
  return requestJson<T>(`${runtimeApiBaseUrl}/library/${comicId}`)
}

export async function deleteLibraryComic(comicId: string): Promise<{ deleted: boolean }> {
  return requestJson<{ deleted: boolean }>(`${runtimeApiBaseUrl}/library/${comicId}`, {
    method: 'DELETE'
  })
}

export async function downloadLibraryChaptersOffline(
  comicId: string,
  payload: DownloadOfflineChaptersPayload
): Promise<DownloadOfflineChaptersResponse> {
  return requestJson<DownloadOfflineChaptersResponse>(`${runtimeApiBaseUrl}/library/${comicId}/offline`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export async function getLibraryChapterPages(
  comicId: string,
  chapterId: string
): Promise<ChapterPagesResponse> {
  return requestJson<ChapterPagesResponse>(
    `${runtimeApiBaseUrl}/library/${comicId}/chapters/${chapterId}/pages`
  )
}

export async function importLibraryComic(payload: ImportComicPayload): Promise<ImportComicResponse> {
  return requestJson<ImportComicResponse>(`${runtimeApiBaseUrl}/import/comic`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export async function upsertLibraryVariantPages(
  comicId: string,
  chapterId: string,
  payload: {
    variantId: string
    canonicalChapterId?: string
    pluginId?: string
    pluginTag?: string
    pluginName?: string
    chapterSiteId?: string
    chapterSiteUrl?: string
    language?: string
    languageCodes?: string[]
    name?: string
    pages: Array<{ index: number; fileName: string; url: string }>
    sourceData?: unknown
  }
) {
  return requestJson(`${runtimeApiBaseUrl}/library/${comicId}/chapters/${chapterId}/variants/pages`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export function getChapterPageUrl(chapterId: string, pageIndex: number): string {
  return `${runtimeApiBaseUrl}/chapters/${chapterId}/pages/${pageIndex}`;
}

export function getComicCoverUrl(comicId: string): string {
  return `${runtimeApiBaseUrl}/comics/${comicId}/cover`;
}

export function getLibraryChapterPageUrl(comicId: string, chapterId: string, pageIndex: number): string {
  return `${runtimeApiBaseUrl}/library/${comicId}/chapters/${chapterId}/pages/${pageIndex}`
}

export function setApiBaseUrl(value: string): void {
  runtimeApiBaseUrl = normalizeBaseUrl(value);
  persistApiBaseUrl(runtimeApiBaseUrl);
}

export function getApiBaseUrl(): string {
  return runtimeApiBaseUrl;
}
