import { create } from 'zustand'
import { dbGet, normalizeChapterPages, supportsOnDemandPageList, type ResolvedPage } from 'services'

interface PluginRecordData {
  endpoint?: string
  url?: string
  metadataEndpoint?: string
  features?: unknown
  [key: string]: unknown
}

export interface ChapterPageFetchRequest {
  requestKey: string
  pluginId: string
  chapterSiteId: string
}

export interface ChapterPageFetchEntry {
  status: 'idle' | 'loading' | 'success' | 'error' | 'unsupported'
  pages: ResolvedPage[]
  error: string | null
}

interface ChapterPageFetchStore {
  entries: Record<string, ChapterPageFetchEntry>
  fetchPagesForChapter: (request: ChapterPageFetchRequest) => Promise<ChapterPageFetchEntry>
  clearPagesForChapter: (requestKey: string) => void
}

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, '')

const fetchPluginMetadata = async (data: PluginRecordData): Promise<unknown> => {
  const endpoint =
    typeof data.metadataEndpoint === 'string' && data.metadataEndpoint.trim()
      ? normalizeBaseUrl(data.metadataEndpoint)
      : typeof data.endpoint === 'string' && data.endpoint.trim()
        ? `${normalizeBaseUrl(data.endpoint)}/metadata`
        : typeof data.url === 'string' && data.url.trim()
          ? `${normalizeBaseUrl(data.url)}/metadata`
          : ''

  if (!endpoint) return null

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs = 30_000): Promise<T> =>
  await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      window.setTimeout(() => reject(new Error('Plugin request timed out')), timeoutMs)
    })
  ])

const emptyEntry = (status: ChapterPageFetchEntry['status'], error: string | null = null): ChapterPageFetchEntry => ({
  status,
  pages: [],
  error
})

const inFlightRequests = new Map<string, Promise<ChapterPageFetchEntry>>()

export const useChapterPageFetchStore = create<ChapterPageFetchStore>((set, get) => ({
  entries: {},
  fetchPagesForChapter: async (request) => {
    const current = get().entries[request.requestKey]
    if (current?.status === 'loading' || current?.status === 'success') {
      return current
    }

    const existing = inFlightRequests.get(request.requestKey)
    if (existing) {
      return existing
    }

    const promise = (async () => {
      set((state) => ({
        entries: {
          ...state.entries,
          [request.requestKey]: emptyEntry('loading')
        }
      }))

      const pluginRecord = await dbGet<PluginRecordData>('plugins', request.pluginId)
      if (!pluginRecord?.data) {
        const next = emptyEntry('error', 'Plugin not installed')
        set((state) => ({
          entries: {
            ...state.entries,
            [request.requestKey]: next
          }
        }))
        return next
      }

      const pluginData = pluginRecord.data
      let onDemandSupport = supportsOnDemandPageList(pluginData.features)

      if (onDemandSupport === undefined) {
        const metadata = await fetchPluginMetadata(pluginData)
        const metadataFeatures =
          metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).features : undefined
        onDemandSupport = supportsOnDemandPageList(metadataFeatures)
      }

      if (onDemandSupport !== true) {
        const next = emptyEntry('unsupported')
        set((state) => ({
          entries: {
            ...state.entries,
            [request.requestKey]: next
          }
        }))
        return next
      }

      const endpoint =
        typeof pluginData.endpoint === 'string' && pluginData.endpoint.trim()
          ? normalizeBaseUrl(pluginData.endpoint)
          : typeof pluginData.url === 'string' && pluginData.url.trim()
            ? normalizeBaseUrl(pluginData.url)
            : ''

      if (!endpoint) {
        const next = emptyEntry('error', 'Plugin endpoint unavailable')
        set((state) => ({
          entries: {
            ...state.entries,
            [request.requestKey]: next
          }
        }))
        return next
      }

      try {
        const response = await withTimeout(
          fetch(`${endpoint}/getPages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chapterSiteId: request.chapterSiteId })
          })
        )

        if (!response.ok) {
          throw new Error(`Plugin request failed (${response.status})`)
        }

        const raw = (await response.json()) as unknown
        const pages = normalizeChapterPages(raw)
        const next: ChapterPageFetchEntry = {
          status: 'success',
          pages,
          error: null
        }
        set((state) => ({
          entries: {
            ...state.entries,
            [request.requestKey]: next
          }
        }))
        return next
      } catch (error) {
        const next = emptyEntry(
          'error',
          error instanceof Error ? error.message : 'Failed to fetch pages'
        )
        set((state) => ({
          entries: {
            ...state.entries,
            [request.requestKey]: next
          }
        }))
        return next
      } finally {
        inFlightRequests.delete(request.requestKey)
      }
    })()

    inFlightRequests.set(request.requestKey, promise)
    return promise
  },
  clearPagesForChapter: (requestKey) =>
    set((state) => {
      if (!state.entries[requestKey]) return state
      const nextEntries = { ...state.entries }
      delete nextEntries[requestKey]
      return { entries: nextEntries }
    })
}))
