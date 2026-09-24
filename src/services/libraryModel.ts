import type { DbRecord } from './restClient'
import type {
  CanonicalChapterData,
  ChapterMappingData,
  ChapterVariantData,
  WorkData
} from './workModel'

export interface ComicPage {
  index: number
  fileName: string
  url: string
}

export interface OfflineChapterFile {
  available?: boolean
  cbzFile?: string | null
  pageCount?: number | null
  sizeBytes?: number | null
  updatedAt?: string | null
}

export interface ComicChapterVariant {
  id: string
  language?: string | null
  pluginId?: string | null
  pluginTag?: string | null
  pluginName?: string | null
  chapterSiteId?: string | null
  chapterSiteUrl?: string | null
  pages: ComicPage[]
  offline?: OfflineChapterFile | null
  sourceData?: unknown
  name?: string | null
}

export interface ComicChapter {
  id: string
  number: string
  sortKey?: number | null
  title?: string | null
  titleByLanguage?: Record<string, string>
  availableLanguages: string[]
  variants: ComicChapterVariant[]
}

export interface ComicMetadata {
  schemaVersion: number
  id: string
  slug: string
  title: string
  description?: string | null
  publisher?: string | null
  status?: string | null
  contentType?: string | null
  cover?: {
    remoteUrl?: string | null
    localFile?: string | null
  } | null
  sources: Array<{
    pluginId?: string | null
    pluginTag?: string | null
    pluginName?: string | null
    sourceSiteId?: string | null
    sourceSiteUrl?: string | null
  }>
  languages: string[]
  chapters: ComicChapter[]
  updatedAt: string
}

export interface ComicChapterGraph {
  work: DbRecord<WorkData>
  canonicalChapters: Array<DbRecord<CanonicalChapterData>>
  chapterVariants: Array<DbRecord<ChapterVariantData>>
  chapterMappings: Array<DbRecord<ChapterMappingData>>
}

const normalizeLanguageCode = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase().replace(/_/g, '-')
}

const variantLanguageCodes = (variant: ComicChapterVariant): string[] => {
  const sourceData =
    variant.sourceData && typeof variant.sourceData === 'object'
      ? (variant.sourceData as Record<string, unknown>)
      : null

  const fromSourceData = sourceData
    ? [
        sourceData.language,
        sourceData.lang,
        ...(Array.isArray(sourceData.languageCodes) ? sourceData.languageCodes : []),
        ...(Array.isArray(sourceData.languages) ? sourceData.languages : [])
      ]
        .map((entry) => normalizeLanguageCode(entry))
        .filter(Boolean)
    : []

  const direct = normalizeLanguageCode(variant.language)
  return Array.from(new Set([...fromSourceData, direct].filter(Boolean)))
}

export const mapComicMetadataToWorkRecord = (metadata: ComicMetadata): DbRecord<WorkData> => ({
  id: metadata.id,
  created_at: metadata.updatedAt,
  updated_at: metadata.updatedAt,
  data: {
    title: metadata.title,
    name: metadata.title,
    description: metadata.description ?? undefined,
    synopsis: metadata.description ?? undefined,
    cover: metadata.cover?.localFile ? undefined : metadata.cover?.remoteUrl ?? undefined,
    publisher: metadata.publisher ?? undefined,
    status: metadata.status ?? undefined,
    chapterCount: metadata.chapters.length
  }
})

export const buildComicChapterGraph = (metadata: ComicMetadata): ComicChapterGraph => {
  const work = mapComicMetadataToWorkRecord(metadata)
  const canonicalChapters: Array<DbRecord<CanonicalChapterData>> = []
  const chapterVariants: Array<DbRecord<ChapterVariantData>> = []
  const chapterMappings: Array<DbRecord<ChapterMappingData>> = []

  for (const chapter of metadata.chapters) {
    canonicalChapters.push({
      id: chapter.id,
      created_at: metadata.updatedAt,
      updated_at: metadata.updatedAt,
      data: {
        workId: metadata.id,
        number: chapter.number,
        name: chapter.title ?? chapter.number,
        raw: {
          titleByLanguage: chapter.titleByLanguage ?? {}
        }
      }
    })

    for (const variant of chapter.variants) {
      const languageCodes = variantLanguageCodes(variant)
      const rawSourceData =
        variant.sourceData && typeof variant.sourceData === 'object'
          ? (variant.sourceData as Record<string, unknown>)
          : {}
      chapterVariants.push({
        id: variant.id,
        created_at: metadata.updatedAt,
        updated_at: metadata.updatedAt,
        data: {
          workId: metadata.id,
          pluginId: variant.pluginId ?? undefined,
          pluginTag: variant.pluginTag ?? undefined,
          pluginName: variant.pluginName ?? undefined,
          sourceId: variant.chapterSiteId ?? undefined,
          sourceName: variant.pluginName ?? undefined,
          siteId: variant.chapterSiteId ?? undefined,
          siteLink: variant.chapterSiteUrl ?? undefined,
          number: chapter.number,
          name: variant.name ?? chapter.title ?? chapter.number,
          language: variant.language ?? undefined,
          languageCodes,
          pages: variant.pages,
          raw: {
            ...rawSourceData,
            offline: variant.offline ?? undefined,
            sourceData: variant.sourceData ?? undefined
          }
        }
      })
      chapterMappings.push({
        id: `${chapter.id}:${variant.id}`,
        created_at: metadata.updatedAt,
        updated_at: metadata.updatedAt,
        data: {
          workId: metadata.id,
          canonicalChapterId: chapter.id,
          variantChapterId: variant.id,
          strategy: 'metadata',
          confidence: 1
        }
      })
    }
  }

  return {
    work,
    canonicalChapters,
    chapterVariants,
    chapterMappings
  }
}
