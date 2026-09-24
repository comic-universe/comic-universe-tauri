import { importLibraryComic, type DbRecord, type ComicMetadata } from 'services'
import { normalizePluginFeatures } from 'services'
import i18n from 'i18n'

export interface PluginRecordData {
  endpoint?: string
  url?: string
  enabled?: boolean
  name?: string
  tag?: string
  contentTypes?: string[]
  languageCodes?: string[]
  capabilities?: string[] | { metadata?: boolean; content?: boolean }
  features?: { onDemandPageList?: boolean }
  sources?: Array<{
    id?: string
    name?: string
    languageCodes?: string[]
    isDefault?: boolean
  }>
  [key: string]: unknown
}

export interface InstalledPlugin {
  id: string
  name: string
  tag: string
  endpoint: string
  enabled: boolean
  contentTypes: string[]
  languageCodes: string[]
  providesMetadata: boolean
  providesContent: boolean
  supportsOnDemandPageList: boolean
  sourceId?: string
  sourceName?: string
}

interface NormalizedChapter {
  siteId?: string
  siteLink?: string
  name: string
  number: string
  languageCodes: string[]
  pages: Array<Record<string, unknown>>
  raw: Record<string, unknown>
}

interface CanonicalChapter {
  siteId?: string
  siteLink?: string
  name: string
  number: string
  languageCodes: string[]
  raw: Record<string, unknown>
}

export interface SearchResultItem {
  id: string
  pluginId: string
  pluginName: string
  pluginTag: string
  endpoint: string
  sourceId?: string
  sourceName?: string
  contentType: string
  title: string
  description: string
  cover: string
  siteId: string
  siteLink: string
  languages: string[]
  chapterCount: number | null
  rawComic: Record<string, unknown>
  contentSiteIdByPlugin?: Record<string, string>
}

export interface SearchResultDetails {
  description: string
  cover: string
  chapterCount: number
}

export interface PluginSearchError {
  pluginId: string
  pluginName: string
  endpoint: string
  message: string
}

export interface SearchByPluginsResult {
  results: SearchResultItem[]
  errors: PluginSearchError[]
}

export interface AddToDatabaseProgress {
  value: number
  message?: string
}

export interface RefreshComicChaptersResult {
  sourcesChecked: number
  sourcesUpdated: number
  chaptersImported: number
  chaptersSkipped: number
}

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, '')

const normalizeLanguageCode = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace('_', '-')

const preferredAppLanguageCodes = (): string[] => {
  const primary = normalizeLanguageCode(i18n.resolvedLanguage || i18n.language || 'en')
  const base = primary.split('-')[0]
  const all = [primary, base]

  if (base === 'pt') {
    all.push(primary === 'pt-pt' ? 'pt-br' : 'pt-pt')
  }

  return Array.from(new Set(all.filter(Boolean)))
}

const normalizeToken = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

const normalizeTitleToken = (value: string): string =>
  value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, '')
    .trim()

const tokenizeNormalizedText = (value: string): string[] =>
  normalizeTitleToken(value)
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean)

const normalizeChapterNumber = (value: string): string => {
  const parsed = Number(value)
  if (Number.isFinite(parsed)) return String(parsed)
  return value.trim().toLowerCase()
}

const parseOptionalNonNegativeNumber = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

const stableId = (...values: Array<string | undefined>): string => {
  const joined = values
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => normalizeToken(value))
    .filter(Boolean)
    .join(':')
  return joined || `id:${Date.now()}`
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

const pickString = (value: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const raw = value[key]
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
    if (typeof raw === 'number') return String(raw)
  }
  return ''
}

const pickArrayStrings = (value: Record<string, unknown>, keys: string[]): string[] => {
  for (const key of keys) {
    const raw = value[key]
    if (Array.isArray(raw)) {
      const parsed = raw
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean)
      if (parsed.length) return parsed
    }
    if (typeof raw === 'string' && raw.trim()) {
      if (raw.includes(',')) {
        const parsed = raw
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
        if (parsed.length) return parsed
      }
      return [raw.trim()]
    }
  }
  return []
}

const normalizePageEntry = (entry: unknown, index: number): Record<string, unknown> | null => {
  if (typeof entry === 'string') {
    const url = entry.trim()
    if (!url) return null
    return {
      url,
      fileName: `page-${index + 1}`
    }
  }

  if (!entry || typeof entry !== 'object') return null
  const item = entry as Record<string, unknown>
  const urlRaw =
    (typeof item.url === 'string' && item.url) ||
    (typeof item.path === 'string' && item.path) ||
    (typeof item.src === 'string' && item.src) ||
    ''
  const url = urlRaw.trim()
  if (!url) return null

  const fileNameRaw =
    (typeof item.fileName === 'string' && item.fileName) ||
    (typeof item.filename === 'string' && item.filename) ||
    (typeof item.name === 'string' && item.name) ||
    `page-${index + 1}`

  return {
    ...item,
    url,
    fileName: fileNameRaw.trim() || `page-${index + 1}`
  }
}

const parsePagesValue = (raw: unknown): Array<Record<string, unknown>> => {
  if (Array.isArray(raw)) {
    return raw
      .map((entry, index) => normalizePageEntry(entry, index))
      .filter((item): item is Record<string, unknown> => Boolean(item))
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry, index) => normalizePageEntry(entry, index))
          .filter((item): item is Record<string, unknown> => Boolean(item))
      }
    } catch {
      return []
    }
  }
  return []
}

const needsDetailsFetch = (result: SearchResultItem): boolean => {
  const descriptionFromSearch =
    pickString(result.rawComic, ['synopsis', 'description']) || result.description
  const coverFromSearch = pickString(result.rawComic, ['cover']) || result.cover
  const missingChapterCount = result.chapterCount === null || !Number.isFinite(result.chapterCount)
  return !descriptionFromSearch || !coverFromSearch || missingChapterCount
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs = 30_000): Promise<T> =>
  await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      window.setTimeout(() => reject(new Error('Plugin request timed out')), timeoutMs)
    })
  ])

const postPlugin = async <T>(
  endpoint: string,
  path: string,
  body: Record<string, unknown>
): Promise<T> => {
  const response = await withTimeout(
    fetch(`${normalizeBaseUrl(endpoint)}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  )

  if (!response.ok) {
    throw new Error(`Plugin request failed (${response.status}) at ${path}`)
  }
  return (await response.json()) as T
}

const resolvePreferredLanguageCodes = (plugin?: InstalledPlugin): string[] => {
  const pluginLanguages = (plugin?.languageCodes || []).map(normalizeLanguageCode)
  const all = [...preferredAppLanguageCodes(), ...pluginLanguages].filter(Boolean)

  return Array.from(new Set(all))
}

const resolveCapabilities = (data: PluginRecordData): { metadata: boolean; content: boolean } => {
  const raw = data.capabilities
  if (Array.isArray(raw)) {
    const normalized = raw.map((entry) => entry.toLowerCase())
    return {
      metadata: normalized.includes('metadata'),
      content: normalized.includes('content')
    }
  }

  if (raw && typeof raw === 'object') {
    const parsed = raw as { metadata?: boolean; content?: boolean }
    return {
      metadata: parsed.metadata !== false,
      content: parsed.content !== false
    }
  }

  return { metadata: true, content: true }
}

const normalizePlugin = (record: DbRecord<PluginRecordData>): InstalledPlugin | null => {
  const endpoint = record.data.endpoint || record.data.url
  if (!endpoint || typeof endpoint !== 'string') return null

  const contentTypes = Array.isArray(record.data.contentTypes)
    ? record.data.contentTypes.filter((value): value is string => typeof value === 'string')
    : []
  if (contentTypes.length > 0 && !contentTypes.some((type) => ['comic', 'manga'].includes(type))) {
    return null
  }

  const defaultSource =
    record.data.sources?.find((source) => source?.isDefault) || record.data.sources?.[0]
  const capabilities = resolveCapabilities(record.data)

  return {
    id: record.id,
    name: record.data.name || record.data.tag || record.id,
    tag: record.data.tag || record.id,
    endpoint: normalizeBaseUrl(endpoint),
    enabled: record.data.enabled !== false,
    contentTypes: contentTypes.length > 0 ? contentTypes : ['comic'],
    languageCodes: Array.isArray(record.data.languageCodes)
      ? record.data.languageCodes.filter((entry): entry is string => typeof entry === 'string')
      : [],
    providesMetadata: capabilities.metadata,
    providesContent: capabilities.content,
    supportsOnDemandPageList: normalizePluginFeatures(record.data.features).onDemandPageList === true,
    sourceId: defaultSource?.id,
    sourceName: defaultSource?.name
  }
}

const deriveLanguages = (
  rawComic: Record<string, unknown>,
  details: Record<string, unknown>,
  plugin: InstalledPlugin
): string[] => {
  const fromComic = pickArrayStrings(rawComic, ['languageCodes', 'languages'])
  if (fromComic.length) return fromComic

  const language = pickString(rawComic, ['language', 'lang']) || pickString(details, ['language', 'lang'])
  if (language) return [language]

  return plugin.languageCodes.length > 0 ? plugin.languageCodes : ['unknown']
}

const normalizeChapters = async (
  plugin: InstalledPlugin,
  _rawComic: Record<string, unknown>,
  chaptersRaw: unknown[]
): Promise<NormalizedChapter[]> => {
  const preferredLanguages = resolvePreferredLanguageCodes(plugin)
  const chapters = chaptersRaw.map(asRecord).filter((chapter) => Object.keys(chapter).length > 0)
  const normalized: NormalizedChapter[] = []

  for (const chapter of chapters) {
    const chapterSiteId = pickString(chapter, ['siteId', 'id'])
    const chapterSiteLink = pickString(chapter, ['siteLink', 'url', 'path'])
    const pageCountHint = parseOptionalNonNegativeNumber(
      chapter.pageCount ?? chapter.pagesCount ?? chapter.page_count
    )
    const readableFlag = typeof chapter.readable === 'boolean' ? chapter.readable : undefined
    const isClearlyUnreadable =
      readableFlag === false ||
      Boolean(chapterSiteLink) ||
      (pageCountHint === 0 && Boolean(chapterSiteId))

    let pages = parsePagesValue(chapter.pages ?? chapter.pictures ?? chapter.images)
    const isReadableCandidate =
      pages.length > 0 ||
      readableFlag === true ||
      (pageCountHint !== null && pageCountHint > 0) ||
      (Boolean(chapterSiteId) && !chapterSiteLink && readableFlag !== false)

    if (isClearlyUnreadable || !isReadableCandidate) {
      continue
    }

    const languageCodes = Array.from(
      new Set(
        [
          ...pickArrayStrings(chapter, ['languageCodes', 'languages']),
          pickString(chapter, ['language', 'lang'])
        ]
          .map((value) => normalizeLanguageCode(value))
          .filter(Boolean)
      )
    )

    normalized.push({
      siteId: chapterSiteId,
      siteLink: chapterSiteLink,
      name: pickString(chapter, ['name', 'title']),
      number: pickString(chapter, ['number', 'chapterNumber']),
      languageCodes,
      pages,
      raw: chapter
    })
  }

  return normalized.sort((left, right) => {
    const leftValue = Number(left.number)
    const rightValue = Number(right.number)
    const leftValid = Number.isFinite(leftValue)
    const rightValid = Number.isFinite(rightValue)

    if (leftValid && rightValid && leftValue !== rightValue) return leftValue - rightValue
    if (leftValid && !rightValid) return -1
    if (!leftValid && rightValid) return 1

    const leftRank = chapterLanguageRank(left.languageCodes, preferredLanguages)
    const rightRank = chapterLanguageRank(right.languageCodes, preferredLanguages)
    if (leftRank !== rightRank) return leftRank - rightRank

    if (left.pages.length !== right.pages.length) return right.pages.length - left.pages.length

    return (left.siteId || left.name).localeCompare(right.siteId || right.name)
  })
}

const normalizeCanonicalChapters = (chaptersRaw: unknown[], fallbackLanguages: string[]): CanonicalChapter[] => {
  const chapters = chaptersRaw.map(asRecord).filter((chapter) => Object.keys(chapter).length > 0)
  const canonical = chapters.map((chapter, index) => {
    const number = pickString(chapter, ['number', 'chapterNumber']) || String(index + 1)
    const languageCodes = Array.from(
      new Set(
        [
          ...pickArrayStrings(chapter, ['languageCodes', 'languages']),
          pickString(chapter, ['language', 'lang']),
          ...fallbackLanguages
        ].filter(Boolean)
      )
    )

    return {
      siteId: pickString(chapter, ['siteId', 'id']) || undefined,
      siteLink: pickString(chapter, ['siteLink', 'url', 'path']) || undefined,
      name: pickString(chapter, ['name', 'title']),
      number,
      languageCodes,
      raw: chapter
    }
  })

  const byNumber = new Map<string, CanonicalChapter>()
  for (const chapter of canonical) {
    const key = normalizeChapterNumber(chapter.number)
    const current = byNumber.get(key)
    if (!current) {
      byNumber.set(key, chapter)
      continue
    }

    current.languageCodes = Array.from(new Set([...current.languageCodes, ...chapter.languageCodes]))
    if (preferredChapterTitle(chapter.name).length > preferredChapterTitle(current.name).length) {
      current.name = chapter.name
    }
    if (!current.siteId && chapter.siteId) {
      current.siteId = chapter.siteId
    }
    if (!current.siteLink && chapter.siteLink) {
      current.siteLink = chapter.siteLink
    }
  }

  return Array.from(byNumber.values())
}

const chapterLanguageRank = (chapterLanguages: string[], preferredLanguages: string[]): number => {
  if (chapterLanguages.length === 0) return Number.MAX_SAFE_INTEGER

  return chapterLanguages.reduce((best, language) => {
    const normalized = normalizeLanguageCode(language)
    const index = preferredLanguages.findIndex(
      (preferred) => preferred === normalized || preferred === normalized.split('-')[0]
    )
    return index >= 0 ? Math.min(best, index) : best
  }, Number.MAX_SAFE_INTEGER)
}

const preferredChapterTitle = (value: string): string => value.trim()

const normalizeSearchResult = (plugin: InstalledPlugin, rawComicInput: unknown): SearchResultItem | null => {
  const rawComic = asRecord(rawComicInput)
  const siteId = pickString(rawComic, ['siteId', 'id'])
  const title = pickString(rawComic, ['name', 'title'])
  if (!siteId || !title) return null

  const details: Record<string, unknown> = {}
  const description = pickString(rawComic, ['synopsis', 'description'])
  const cover = pickString(rawComic, ['cover']) || ''
  const siteLink = pickString(rawComic, ['siteLink', 'url', 'path'])
  const contentType = pickString(rawComic, ['contentType', 'type']) || plugin.contentTypes[0] || 'comic'
  const chapterCountRaw = pickString(rawComic, ['chapterCount', 'chaptersCount', 'totalChapters'])
  const chapterCount = chapterCountRaw ? Number(chapterCountRaw) : null

  return {
    id: stableId('result', plugin.tag, siteId),
    pluginId: plugin.id,
    pluginName: plugin.name,
    pluginTag: plugin.tag,
    endpoint: plugin.endpoint,
    sourceId: plugin.sourceId,
    sourceName: plugin.sourceName,
    contentType,
    title,
    description,
    cover,
    siteId,
    siteLink,
    languages: deriveLanguages(rawComic, details, plugin),
    chapterCount: Number.isFinite(chapterCount) ? chapterCount : null,
    rawComic
  }
}

const pickBestSearchMatch = (title: string, candidates: unknown[]): Record<string, unknown> | null => {
  const target = normalizeTitleToken(title)
  if (!target) return null

  let best: Record<string, unknown> | null = null
  let bestScore = -1
  for (const candidateRaw of candidates) {
    const candidate = asRecord(candidateRaw)
    const candidateTitle = pickString(candidate, ['name', 'title'])
    const normalizedCandidateTitle = normalizeTitleToken(candidateTitle)
    if (!normalizedCandidateTitle) continue

    let score = 0
    if (normalizedCandidateTitle === target) score += 100
    if (normalizedCandidateTitle.includes(target) || target.includes(normalizedCandidateTitle)) score += 20

    const targetWords = target.split(' ').filter(Boolean)
    const candidateWords = new Set(normalizedCandidateTitle.split(' ').filter(Boolean))
    for (const word of targetWords) {
      if (candidateWords.has(word)) score += 3
    }

    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }

  return best
}

const searchMatchScore = (query: string, title: string): number => {
  const normalizedQuery = normalizeTitleToken(query)
  const normalizedTitle = normalizeTitleToken(title)
  if (!normalizedQuery || !normalizedTitle) return 0

  if (normalizedQuery === normalizedTitle) return 1
  if (normalizedTitle.startsWith(normalizedQuery)) return 0.95
  if (normalizedTitle.includes(normalizedQuery)) return 0.85

  const queryTokens = tokenizeNormalizedText(query)
  const titleTokens = new Set(tokenizeNormalizedText(title))
  if (queryTokens.length === 0) return 0

  let matched = 0
  for (const token of queryTokens) {
    if (titleTokens.has(token)) {
      matched += 1
      continue
    }
    for (const titleToken of titleTokens) {
      if (titleToken.startsWith(token) || token.startsWith(titleToken)) {
        matched += 0.8
        break
      }
    }
  }

  return Math.max(0, Math.min(1, matched / queryTokens.length))
}

const normalizedAppLanguageCodes = (): string[] => {
  return preferredAppLanguageCodes()
}

const languageMatchesApp = (languages: string[]): boolean => {
  const normalizedItemLanguages = languages.map(normalizeLanguageCode)
  const appLanguages = normalizedAppLanguageCodes()
  return normalizedItemLanguages.some((lang) => appLanguages.includes(lang) || appLanguages.includes(lang.split('-')[0]))
}

const titleRelationScore = (left: string, right: string): number => {
  const leftTitle = normalizeTitleToken(left)
  const rightTitle = normalizeTitleToken(right)
  if (!leftTitle || !rightTitle) return 0
  if (leftTitle === rightTitle) return 1
  if (leftTitle.includes(rightTitle) || rightTitle.includes(leftTitle)) return 0.94

  const leftTokens = new Set(tokenizeNormalizedText(left))
  const rightTokens = new Set(tokenizeNormalizedText(right))
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0

  let overlap = 0
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1
  }

  const union = new Set([...leftTokens, ...rightTokens]).size
  return union > 0 ? overlap / union : 0
}

const fetchContentChaptersForResult = async (
  plugin: InstalledPlugin,
  result: SearchResultItem
): Promise<NormalizedChapter[]> => {
  const preferredLanguages = resolvePreferredLanguageCodes(plugin)
  let pluginComic = result.rawComic
  let siteId = result.siteId

  if (plugin.id !== result.pluginId) {
    const mappedSiteId = result.contentSiteIdByPlugin?.[plugin.id]
    if (mappedSiteId) {
      const chaptersRaw = await postPlugin<unknown[]>(plugin.endpoint, 'getChapters', {
        siteId: mappedSiteId,
        languageCodes: preferredLanguages
      })
      return normalizeChapters(plugin, { siteId: mappedSiteId }, chaptersRaw)
    }

    const pluginSearchResults = await postPlugin<unknown[]>(plugin.endpoint, 'search', {
      search: result.title,
      languageCodes: preferredLanguages
    })
    const best = pickBestSearchMatch(result.title, pluginSearchResults)
    if (!best) return []
    pluginComic = best
    siteId = pickString(best, ['siteId', 'id'])
    if (!siteId) return []
  }

  const chaptersRaw = await postPlugin<unknown[]>(plugin.endpoint, 'getChapters', {
    siteId,
    languageCodes: preferredLanguages
  })

  return normalizeChapters(plugin, pluginComic, chaptersRaw)
}

export const listInstalledPlugins = (
  records: Array<DbRecord<PluginRecordData>>
): InstalledPlugin[] =>
  records
    .map(normalizePlugin)
    .filter((plugin): plugin is InstalledPlugin => plugin !== null)
    .sort((a, b) => a.name.localeCompare(b.name))

export const listInstalledContentPlugins = (
  records: Array<DbRecord<PluginRecordData>>
): InstalledPlugin[] =>
  listInstalledPlugins(records).filter((plugin) => plugin.providesContent)

export const listInstalledMetadataPlugins = (
  records: Array<DbRecord<PluginRecordData>>
): InstalledPlugin[] =>
  listInstalledPlugins(records).filter((plugin) => plugin.providesMetadata)

export const searchByPlugins = async (
  plugins: InstalledPlugin[],
  query: string
): Promise<SearchByPluginsResult> => {
  const trimmed = query.trim()
  if (!trimmed) {
    return { results: [], errors: [] }
  }

  const metadataPlugins = plugins.filter((plugin) => plugin.providesMetadata)
  const contentPlugins = plugins.filter((plugin) => plugin.providesContent)
  if (metadataPlugins.length === 0) {
    return { results: [], errors: [] }
  }

  const byPlugin = await Promise.all(
    metadataPlugins.map(async (plugin) => {
      try {
        const preferredLanguages = resolvePreferredLanguageCodes(plugin)
        const baseList = await postPlugin<unknown[]>(plugin.endpoint, 'search', {
          search: trimmed,
          languageCodes: preferredLanguages
        })

        const limited = baseList.slice(0, 50)
        const minScore = trimmed.length <= 3 ? 0.34 : 0.5
        return {
          results: limited
            .map((item) => {
              const normalized = normalizeSearchResult(plugin, item)
              if (!normalized) return null
              const score = searchMatchScore(trimmed, normalized.title)
              if (score < minScore) return null
              return normalized
            })
            .filter((item): item is SearchResultItem => item !== null),
          error: null as PluginSearchError | null
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : i18n.t('searchContent.errors.unknownPlugin')
        return {
          results: [],
          error: {
            pluginId: plugin.id,
            pluginName: plugin.name,
            endpoint: plugin.endpoint,
            message
          } satisfies PluginSearchError
        }
      }
    })
  )

  const dedupedBySource = new Map<string, SearchResultItem>()
  for (const item of byPlugin.flatMap((entry) => entry.results)) {
    const key = `${item.pluginTag}:${item.siteId}`
    if (!dedupedBySource.has(key)) {
      dedupedBySource.set(key, item)
    }
  }

  // Probe content providers too so metadata results can be ranked by real content availability
  // in the current app language.
  const contentByPlugin = await Promise.all(
    contentPlugins.map(async (plugin) => {
      try {
        const preferredLanguages = resolvePreferredLanguageCodes(plugin)
        const baseList = await postPlugin<unknown[]>(plugin.endpoint, 'search', {
          search: trimmed,
          languageCodes: preferredLanguages
        })
        return baseList
          .slice(0, 40)
          .map((item) => normalizeSearchResult(plugin, item))
          .filter((item): item is SearchResultItem => item !== null)
      } catch {
        return [] as SearchResultItem[]
      }
    })
  )
  const contentCandidates = contentByPlugin.flat()
  const contentSiteByResultId = new Map<string, Map<string, string>>()

  const relatedContentByResultId = new Map<string, { hasAny: boolean; hasAppLanguage: boolean }>()
  for (const item of dedupedBySource.values()) {
    let hasAny = false
    let hasAppLanguage = false
    const bestByPlugin = new Map<string, { score: number; siteId: string; languageBoost: number }>()
    for (const content of contentCandidates) {
      const score = titleRelationScore(item.title, content.title)
      if (score < 0.7) continue
      hasAny = true
      const inAppLanguage = languageMatchesApp(content.languages)
      if (inAppLanguage) {
        hasAppLanguage = true
      }

      const languageBoost = inAppLanguage ? 1 : 0
      const current = bestByPlugin.get(content.pluginId)
      if (!current || score + languageBoost * 0.2 > current.score + current.languageBoost * 0.2) {
        bestByPlugin.set(content.pluginId, {
          score,
          siteId: content.siteId,
          languageBoost
        })
      }
    }
    relatedContentByResultId.set(item.id, { hasAny, hasAppLanguage })
    if (bestByPlugin.size > 0) {
      const map = new Map<string, string>()
      for (const [pluginId, match] of bestByPlugin.entries()) {
        map.set(pluginId, match.siteId)
      }
      contentSiteByResultId.set(item.id, map)
    }
  }

  // Relate metadata results across plugins by title similarity so we surface one best representative
  // with merged metadata hints.
  const clusters: SearchResultItem[][] = []
  for (const item of dedupedBySource.values()) {
    const cluster = clusters.find((current) =>
      current.some((candidate) => titleRelationScore(candidate.title, item.title) >= 0.74)
    )
    if (cluster) {
      cluster.push(item)
    } else {
      clusters.push([item])
    }
  }

  const mergedResults = clusters.map((cluster) => {
    const sortedCluster = [...cluster].sort((a, b) => {
      const aContent = relatedContentByResultId.get(a.id)
      const bContent = relatedContentByResultId.get(b.id)

      const aBoost =
        (aContent?.hasAppLanguage ? 3 : 0) + (aContent?.hasAny ? 1 : 0) + (languageMatchesApp(a.languages) ? 1 : 0)
      const bBoost =
        (bContent?.hasAppLanguage ? 3 : 0) + (bContent?.hasAny ? 1 : 0) + (languageMatchesApp(b.languages) ? 1 : 0)

      const scoreDiff = searchMatchScore(trimmed, b.title) + bBoost - (searchMatchScore(trimmed, a.title) + aBoost)
      if (Math.abs(scoreDiff) > 0.001) return scoreDiff
      return b.title.length - a.title.length
    })

    const representative = { ...sortedCluster[0] }
    representative.languages = Array.from(new Set(cluster.flatMap((item) => item.languages)))
    representative.chapterCount = cluster.reduce<number | null>((max, item) => {
      if (item.chapterCount === null || !Number.isFinite(item.chapterCount)) return max
      if (max === null) return item.chapterCount
      return Math.max(max, item.chapterCount)
    }, representative.chapterCount ?? null)

    const relatedSourceNames = Array.from(
      new Set(cluster.map((item) => item.sourceName || item.pluginName).filter(Boolean))
    )
    representative.sourceName =
      relatedSourceNames.length > 1 ? relatedSourceNames.join(' + ') : relatedSourceNames[0] || representative.sourceName

    const mergedContentMap = new Map<string, string>()
    for (const item of sortedCluster) {
      const byPlugin = contentSiteByResultId.get(item.id)
      if (!byPlugin) continue
      for (const [pluginId, siteId] of byPlugin.entries()) {
        if (!mergedContentMap.has(pluginId)) {
          mergedContentMap.set(pluginId, siteId)
        }
      }
    }
    if (mergedContentMap.size > 0) {
      representative.contentSiteIdByPlugin = Object.fromEntries(mergedContentMap.entries())
    }

    return representative
  })

  const results = mergedResults.sort((a, b) => {
    const aContent = relatedContentByResultId.get(a.id)
    const bContent = relatedContentByResultId.get(b.id)

    const aBoost =
      (aContent?.hasAppLanguage ? 3 : 0) + (aContent?.hasAny ? 1 : 0) + (languageMatchesApp(a.languages) ? 1 : 0)
    const bBoost =
      (bContent?.hasAppLanguage ? 3 : 0) + (bContent?.hasAny ? 1 : 0) + (languageMatchesApp(b.languages) ? 1 : 0)

    const scoreDiff = searchMatchScore(trimmed, b.title) + bBoost - (searchMatchScore(trimmed, a.title) + aBoost)
    if (Math.abs(scoreDiff) > 0.001) return scoreDiff
    return a.title.localeCompare(b.title)
  })

  const errors = byPlugin
    .map((entry) => entry.error)
    .filter((entry): entry is PluginSearchError => entry !== null)

  return { results, errors }
}

export const addSearchResultToDatabase = async (
  result: SearchResultItem,
  selectedPlugins: InstalledPlugin[],
  options?: {
    targetComicId?: string
    onProgress?: (progress: AddToDatabaseProgress) => void
  }
): Promise<void> => {
  const updateProgress = (value: number, message?: string) => {
    options?.onProgress?.({
      value: Math.max(0, Math.min(100, Math.round(value))),
      message
    })
  }

  const metadataPlugin = selectedPlugins.find((plugin) => plugin.id === result.pluginId)
  const preferredLanguages = resolvePreferredLanguageCodes(metadataPlugin)
  updateProgress(5, 'searchContent.progress.loadingDetails')
  let details: Record<string, unknown> = {}
  if (needsDetailsFetch(result)) {
    details = asRecord(
      await postPlugin<Record<string, unknown>>(result.endpoint, 'getDetails', {
        siteId: result.siteId,
        languageCodes: preferredLanguages
      })
    )
  }

  let metadataChaptersRaw: unknown[] = []
  try {
    updateProgress(12, 'searchContent.progress.loadingChapterList')
    metadataChaptersRaw = await postPlugin<unknown[]>(result.endpoint, 'getChapters', {
      siteId: result.siteId,
      languageCodes: preferredLanguages
    })
  } catch {
    metadataChaptersRaw = []
  }

  const sourceKey = `${result.pluginTag}:${result.siteId}`
  const chapterCountFromDetails = parseOptionalNonNegativeNumber(
    pickString(details, ['chapterCount', 'chaptersCount', 'totalChapters'])
  )
  const resolvedChapterCount =
    chapterCountFromDetails !== null
      ? chapterCountFromDetails
      : result.chapterCount
  const workData: Record<string, unknown> = {
    title: result.title,
    name: result.title,
    description:
      pickString(details, ['synopsis', 'description']) ||
      pickString(result.rawComic, ['synopsis', 'description']) ||
      result.description ||
      '',
    cover:
      pickString(details, ['cover']) || pickString(result.rawComic, ['cover']) || result.cover || null,
    sourceKey,
    metadataPluginId: result.pluginId,
    metadataPluginTag: result.pluginTag,
    metadataPluginName: result.pluginName,
    sourceSiteId: result.siteId,
    sourceSiteLink: result.siteLink || null,
    contentType: result.contentType,
    languageCodes: result.languages,
    chapterCount: resolvedChapterCount,
    rawMetadata: { ...result.rawComic, ...details }
  }

  const effectiveChapterCount =
    chapterCountFromDetails !== null && chapterCountFromDetails > 0
      ? chapterCountFromDetails
      : (result.chapterCount ?? 0)

  let canonicalChapters = normalizeCanonicalChapters(metadataChaptersRaw, result.languages)
  const chaptersForImport: Array<Record<string, unknown>> = []

  const contentPlugins = selectedPlugins.filter(
    (plugin) =>
      plugin.providesContent &&
      plugin.contentTypes.some((type) => ['comic', 'manga', result.contentType].includes(type))
  )
  const relatedContentPluginIds = new Set<string>([
    result.pluginId,
    ...Object.keys(result.contentSiteIdByPlugin ?? {})
  ])
  const candidateContentPlugins =
    relatedContentPluginIds.size > 0
      ? contentPlugins.filter((plugin) => relatedContentPluginIds.has(plugin.id))
      : contentPlugins
  const prioritizedContentPlugins =
    candidateContentPlugins.length > 0 ? candidateContentPlugins : contentPlugins

  updateProgress(42, 'searchContent.progress.loadingContentSources')
  for (const contentPlugin of prioritizedContentPlugins) {
    let contentChapters: NormalizedChapter[] = []
    try {
      contentChapters = await fetchContentChaptersForResult(contentPlugin, result)
    } catch {
      continue
    }
    if (contentChapters.length === 0) continue

    for (let index = 0; index < contentChapters.length; index += 1) {
      const chapter = contentChapters[index]
      const chapterNumber = chapter.number || String(index + 1)
      chaptersForImport.push({
        ...chapter.raw,
        chapterSiteId: chapter.siteId || null,
        chapterSiteUrl: chapter.siteLink || null,
        number: chapterNumber,
        name: chapter.name || i18n.t('common.chapterLabel', { number: chapterNumber }),
        language: pickString(chapter.raw, ['language', 'lang']) || null,
        languageCodes: chapter.languageCodes,
        pages: chapter.pages,
        pluginId: contentPlugin.id,
        pluginTag: contentPlugin.tag,
        pluginName: contentPlugin.name,
        sourceId: contentPlugin.sourceId || null,
        sourceName: contentPlugin.sourceName || null
      })
    }
  }

  if (canonicalChapters.length === 0 && chaptersForImport.length === 0 && effectiveChapterCount > 0) {
    canonicalChapters = Array.from({ length: effectiveChapterCount }, (_, index) => {
      const number = String(index + 1)
      return {
        number,
        name: i18n.t('common.chapterLabel', { number }),
        languageCodes: result.languages.length ? result.languages : ['unknown'],
        raw: { generated: true, source: 'chapterCount' }
      }
    })
  }
  if (chaptersForImport.length === 0) {
    chaptersForImport.push(
      ...canonicalChapters.map((chapter) => ({
        ...chapter.raw,
        number: chapter.number,
        name: chapter.name || i18n.t('common.chapterLabel', { number: chapter.number }),
        languageCodes: chapter.languageCodes,
        pluginId: result.pluginId,
        pluginTag: result.pluginTag,
        pluginName: result.pluginName
      }))
    )
  }

  const comicData: Record<string, unknown> = {
    ...result.rawComic,
    ...details,
    ...workData,
    sourceTag: result.pluginTag,
    sourceName: result.sourceName || result.pluginName,
    sourceId: result.sourceId || null,
    pluginId: result.pluginId,
    pluginName: result.pluginName,
    sourceSiteId: result.siteId,
    sourceSiteLink: result.siteLink || null
  }

  updateProgress(82, 'searchContent.progress.savingComic')
  await importLibraryComic({
    data: {
      targetComicId: options?.targetComicId,
      comic: comicData,
      chapters: chaptersForImport
    }
  })

  updateProgress(100, 'searchContent.progress.done')
}

export const refreshComicChaptersFromSources = async (
  comic: ComicMetadata,
  installedPlugins: InstalledPlugin[]
): Promise<RefreshComicChaptersResult> => {
  const checkedSourceKeys = new Set<string>()
  const pluginsById = new Map(installedPlugins.map((plugin) => [plugin.id, plugin] as const))
  const pluginsByTag = new Map(installedPlugins.map((plugin) => [plugin.tag, plugin] as const))

  let sourcesChecked = 0
  let sourcesUpdated = 0
  let chaptersImported = 0
  let chaptersSkipped = 0

  for (const source of comic.sources ?? []) {
    const sourceSiteId =
      typeof source.sourceSiteId === 'string' && source.sourceSiteId.trim().length > 0
        ? source.sourceSiteId.trim()
        : ''
    if (!sourceSiteId) continue

    const plugin =
      (typeof source.pluginId === 'string' ? pluginsById.get(source.pluginId) : undefined) ??
      (typeof source.pluginTag === 'string' ? pluginsByTag.get(source.pluginTag) : undefined)
    if (!plugin || !plugin.enabled) continue

    const sourceKey = `${plugin.id}:${sourceSiteId}`
    if (checkedSourceKeys.has(sourceKey)) continue
    checkedSourceKeys.add(sourceKey)
    sourcesChecked += 1

    let chaptersRaw: unknown[] = []
    try {
      chaptersRaw = await postPlugin<unknown[]>(plugin.endpoint, 'getChapters', {
        siteId: sourceSiteId,
        languageCodes: resolvePreferredLanguageCodes(plugin)
      })
    } catch {
      continue
    }

    const contentChapters = await normalizeChapters(plugin, { siteId: sourceSiteId }, chaptersRaw)
    let chaptersForImport: Array<Record<string, unknown>> = []

    if (contentChapters.length > 0) {
      chaptersForImport = contentChapters.map((chapter, index) => {
        const chapterNumber = chapter.number || String(index + 1)
        return {
          ...chapter.raw,
          chapterSiteId: chapter.siteId || null,
          chapterSiteUrl: chapter.siteLink || null,
          number: chapterNumber,
          name: chapter.name || i18n.t('common.chapterLabel', { number: chapterNumber }),
          language: pickString(chapter.raw, ['language', 'lang']) || null,
          languageCodes: chapter.languageCodes,
          pages: chapter.pages,
          pluginId: plugin.id,
          pluginTag: plugin.tag,
          pluginName: plugin.name,
          sourceId: plugin.sourceId || null,
          sourceName: plugin.sourceName || null
        }
      })
    } else {
      const canonicalChapters = normalizeCanonicalChapters(chaptersRaw, comic.languages ?? [])
      chaptersForImport = canonicalChapters.map((chapter) => ({
        ...chapter.raw,
        chapterSiteId: chapter.siteId || null,
        chapterSiteUrl: chapter.siteLink || null,
        number: chapter.number,
        name: chapter.name || i18n.t('common.chapterLabel', { number: chapter.number }),
        languageCodes: chapter.languageCodes,
        pluginId: plugin.id,
        pluginTag: plugin.tag,
        pluginName: plugin.name,
        sourceId: plugin.sourceId || null,
        sourceName: plugin.sourceName || null
      }))
    }

    if (chaptersForImport.length === 0) continue

    const response = await importLibraryComic({
      data: {
        targetComicId: comic.id,
        comic: {
          title: comic.title,
          name: comic.title,
          description: comic.description ?? '',
          publisher: comic.publisher ?? null,
          status: comic.status ?? null,
          contentType: comic.contentType ?? null,
          cover: comic.cover?.remoteUrl ?? null,
          languageCodes: comic.languages,
          sourceTag: source.pluginTag || plugin.tag,
          sourceName: source.pluginName || plugin.name,
          pluginId: source.pluginId || plugin.id,
          pluginName: source.pluginName || plugin.name,
          sourceSiteId,
          sourceSiteLink:
            (typeof source.sourceSiteUrl === 'string' && source.sourceSiteUrl.trim().length > 0
              ? source.sourceSiteUrl
              : null)
        },
        chapters: chaptersForImport
      }
    })

    sourcesUpdated += 1
    chaptersImported += response.chaptersImported
    chaptersSkipped += response.chaptersSkipped
  }

  return {
    sourcesChecked,
    sourcesUpdated,
    chaptersImported,
    chaptersSkipped
  }
}

export const loadSearchResultDetails = async (
  result: SearchResultItem
): Promise<SearchResultDetails> => {
  const preferredLanguages = resolvePreferredLanguageCodes()
  let details: Record<string, unknown> = {}
  if (needsDetailsFetch(result)) {
    details = asRecord(
      await postPlugin<Record<string, unknown>>(result.endpoint, 'getDetails', {
        siteId: result.siteId,
        languageCodes: preferredLanguages
      })
    )
  }

  const description =
    pickString(details, ['synopsis', 'description']) ||
    pickString(result.rawComic, ['synopsis', 'description']) ||
    result.description ||
    ''
  const cover =
    pickString(details, ['cover']) || pickString(result.rawComic, ['cover']) || result.cover || ''
  const chapterCountFromDetails = parseOptionalNonNegativeNumber(
    pickString(details, ['chapterCount', 'chaptersCount', 'totalChapters'])
  )
  const chapterCount =
    chapterCountFromDetails !== null
      ? chapterCountFromDetails
      : (result.chapterCount ?? 0)

  return {
    description,
    cover,
    chapterCount
  }
}
