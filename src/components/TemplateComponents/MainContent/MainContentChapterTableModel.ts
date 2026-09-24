import type { ResolvedChapterRecord } from 'services'

export interface ChapterRowModel {
  id: string
  chapterNumber: string
  chapterName: string
  chapterLanguages: string[]
  isOffline: boolean
  isOfflineDownloading: boolean
  progress: number
  isRead: boolean
  numberSortValue: number | null
}

const extractComparableNumber = (raw: unknown): number | null => {
  if (typeof raw !== 'string') return null
  const normalized = raw.trim().replace(',', '.')
  if (!normalized) return null

  const direct = Number(normalized)
  if (Number.isFinite(direct)) return direct

  const match = normalized.match(/-?\d+(?:\.\d+)?/)
  if (!match) return null
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : null
}

const getChapterNumber = (chapter: ResolvedChapterRecord): string => {
  const number = chapter.data.number
  if (typeof number === 'string' && number.trim().length) return number.trim()
  return '-'
}

const getChapterName = (chapter: ResolvedChapterRecord): string => {
  const name = chapter.data.name
  if (typeof name === 'string' && name.trim().length) return name.trim()
  return ''
}

const getChapterLanguages = (chapter: ResolvedChapterRecord): string[] => {
  const available = Array.isArray(chapter.data.availableLanguageCodes)
    ? chapter.data.availableLanguageCodes
    : []
  const direct = typeof chapter.data.language === 'string' ? [chapter.data.language] : []
  const fromArray = Array.isArray(chapter.data.languageCodes) ? chapter.data.languageCodes : []
  const rawRecord =
    chapter.data.raw && typeof chapter.data.raw === 'object'
      ? (chapter.data.raw as Record<string, unknown>)
      : null
  const raw = rawRecord
    ? [
        rawRecord.language,
        rawRecord.lang,
        ...(Array.isArray(rawRecord.languageCodes) ? rawRecord.languageCodes : [])
      ]
    : []

  return Array.from(
    new Set(
      [...available, ...direct, ...fromArray, ...raw]
        .filter(
          (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
        )
        .map((entry) => entry.trim().toUpperCase())
    )
  )
}

export const mapChapterToRow = (
  chapter: ResolvedChapterRecord,
  progressByChapterId?: Map<string, number>,
  pendingOfflineChapterIds?: Set<string>
): ChapterRowModel => {
  const variantChapterId =
    typeof chapter.data.variantChapterId === 'string' ? chapter.data.variantChapterId : ''
  const progress =
    progressByChapterId?.get(chapter.id) ??
    (variantChapterId ? progressByChapterId?.get(variantChapterId) : undefined) ??
    0
  const rawRecord =
    chapter.data.raw && typeof chapter.data.raw === 'object'
      ? (chapter.data.raw as Record<string, unknown>)
      : null
  const offlineRecord =
    rawRecord?.offline && typeof rawRecord.offline === 'object'
      ? (rawRecord.offline as Record<string, unknown>)
      : null
  const isOffline =
    offlineRecord?.available === true ||
    (typeof offlineRecord?.cbzFile === 'string' && offlineRecord.cbzFile.trim().length > 0)
  const isOfflineDownloading = pendingOfflineChapterIds?.has(chapter.id) ?? false

  return {
    id: chapter.id,
    chapterNumber: getChapterNumber(chapter),
    chapterName: getChapterName(chapter),
    chapterLanguages: getChapterLanguages(chapter),
    isOffline,
    isOfflineDownloading,
    progress,
    isRead: progress >= 100,
    numberSortValue: extractComparableNumber(chapter.data.number)
  }
}
