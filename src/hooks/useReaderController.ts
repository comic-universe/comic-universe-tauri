import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import i18n from 'i18n'
import { useChapterPageFetchStore } from 'stores'
import {
  buildComicChapterGraph,
  type CanonicalChapterData,
  type ChapterMappingData,
  type ChapterVariantData,
  type ResolvedPage,
  getApiBaseUrl,
  normalizeChapterPages,
  mapComicMetadataToWorkRecord,
  resolveChapterVariants,
  restQueryKeys,
  useDbFindQuery,
  useLibraryChapterPagesQuery,
  useLibraryComicQuery,
  useDbUpsertMutation
} from 'services'
import { type HorizontalReaderSlide } from 'components/TemplateComponents/Reader'

interface ReadProgressData {
  chapterId: string
  comicId: string
  page: number
  totalPages: number
  [key: string]: unknown
}

interface ComicPreferencesData {
  scopeId?: string
  readingMode?: 'horizontal' | 'vertical'
  readingDirection?: 'ltr' | 'rtl'
  doublePageSpread?: boolean
  chapterLanguageMode?: string
  [key: string]: unknown
}

const normalizeImageSrc = (value: string | null | undefined): string | undefined => {
  if (!value) return undefined
  const normalized = value.trim()
  return normalized.length ? normalized : undefined
}

const absolutizeApiPath = (value: string): string => {
  const normalized = value.trim()
  if (!normalized) return normalized
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    return normalized
  }
  if (normalized.startsWith('/')) {
    return new URL(normalized, `${getApiBaseUrl()}/`).toString()
  }
  return normalized
}

const AUTO_LANGUAGE_MODE = '__auto__'

const normalizeLanguageCode = (value: string): string => value.trim().toLowerCase().replace(/_/g, '-')

const preferredAppLanguageCodes = (): string[] => {
  const resolved = normalizeLanguageCode(i18n.resolvedLanguage || i18n.language || 'en')
  const base = resolved.split('-')[0]
  const all = [resolved, base]

  if (base === 'pt') {
    all.push(resolved === 'pt-pt' ? 'pt-br' : 'pt-pt')
  }

  return Array.from(new Set(all.filter(Boolean)))
}

const preferredLanguageCodes = (): string[] => {
  return Array.from(new Set([...preferredAppLanguageCodes(), 'en']))
}

const chapterLanguageModeFromSettings = (preferences?: ComicPreferencesData | null): string => {
  const raw = typeof preferences?.chapterLanguageMode === 'string' ? preferences.chapterLanguageMode : ''
  if (raw.trim() === AUTO_LANGUAGE_MODE) return AUTO_LANGUAGE_MODE
  return raw.trim() ? normalizeLanguageCode(raw) : AUTO_LANGUAGE_MODE
}

export const useReaderController = () => {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { comicId, chapterId } = useParams<{ comicId: string; chapterId: string }>()

  const [readingMode, setReadingMode] = useState<'horizontal' | 'vertical'>('horizontal')
  const [readingDirection, setReadingDirection] = useState<'ltr' | 'rtl'>('ltr')
  const [doublePageSpread, setDoublePageSpread] = useState(false)
  const [readProgress, setReadProgress] = useState<ReadProgressData | null>(null)
  const [zoomVisible, setZoomVisible] = useState(false)
  const [isScrollingProgrammatically, setIsScrollingProgrammatically] = useState(false)
  const [isMobileViewport, setIsMobileViewport] = useState(false)
  const [desktopControlsVisible, setDesktopControlsVisible] = useState(true)
  const [verticalDesktopPageHeight, setVerticalDesktopPageHeight] = useState(0)
  const [horizontalViewportWidth, setHorizontalViewportWidth] = useState(0)
  const [horizontalViewportNode, setHorizontalViewportNode] = useState<HTMLDivElement | null>(null)
  const [verticalScrollContainerNode, setVerticalScrollContainerNode] =
    useState<HTMLDivElement | null>(null)
  const [pageAspectMap, setPageAspectMap] = useState<Record<number, 'portrait' | 'landscape'>>({})
  const mainContainerRef = useRef<HTMLDivElement>(null)
  const verticalPageRefs = useRef<Array<HTMLDivElement | null>>([])
  const pendingVerticalSyncRef = useRef(false)
  const pendingVerticalScrollBehaviorRef = useRef<ScrollBehavior>('auto')
  const initialVerticalSyncChapterRef = useRef<string | null>(null)
  const readProgressRecordIdRef = useRef<string | undefined>(undefined)
  const persistDebounceRef = useRef<number | null>(null)
  const persistReadProgressRef = useRef<(next: ReadProgressData) => Promise<void>>(async () => {})
  const lastPersistedRef = useRef<{ chapterId: string; page: number } | null>(null)
  const verticalScrollDebounceRef = useRef<number | null>(null)
  const desktopControlsHideTimeoutRef = useRef<number | null>(null)
  const comicQuery = useLibraryComicQuery(comicId)
  const comicPreferencesQuery = useDbFindQuery<ComicPreferencesData>(
    'app_state',
    'scopeId',
    comicId ?? '',
    1,
    Boolean(comicId)
  )
  const readProgressQuery = useDbFindQuery<ReadProgressData>(
    'read_progress',
    'chapterId',
    chapterId ?? '',
    1,
    Boolean(chapterId)
  )
  const upsertReadProgressMutation = useDbUpsertMutation<ReadProgressData>()
  const upsertAppStateMutation = useDbUpsertMutation<ComicPreferencesData>()

  const chapterGraph = useMemo(() => {
    if (!comicQuery.data) {
      return {
        work: null,
        canonicalChapters: [] as Array<{ id: string; data: CanonicalChapterData; created_at: string; updated_at: string }>,
        chapterVariants: [] as Array<{ id: string; data: ChapterVariantData; created_at: string; updated_at: string }>,
        chapterMappings: [] as Array<{ id: string; data: ChapterMappingData; created_at: string; updated_at: string }>
      }
    }
    return buildComicChapterGraph(comicQuery.data)
  }, [comicQuery.data])

  const setHorizontalViewportRef = useCallback((node: HTMLDivElement | null) => {
    setHorizontalViewportNode(node)
    setHorizontalViewportWidth(node?.clientWidth ?? 0)
  }, [])

  const setVerticalScrollContainerRef = useCallback((node: HTMLDivElement | null) => {
    setVerticalScrollContainerNode(node)
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 768px)')
    const apply = () => setIsMobileViewport(media.matches)
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])

  const showDesktopControls = useCallback(() => {
    if (isMobileViewport) return
    setDesktopControlsVisible(true)
    if (desktopControlsHideTimeoutRef.current !== null) {
      window.clearTimeout(desktopControlsHideTimeoutRef.current)
    }
    desktopControlsHideTimeoutRef.current = window.setTimeout(() => {
      setDesktopControlsVisible(false)
    }, 1800)
  }, [isMobileViewport])

  useEffect(() => {
    if (isMobileViewport) {
      setDesktopControlsVisible(true)
      if (desktopControlsHideTimeoutRef.current !== null) {
        window.clearTimeout(desktopControlsHideTimeoutRef.current)
        desktopControlsHideTimeoutRef.current = null
      }
      return
    }

    showDesktopControls()
  }, [isMobileViewport, showDesktopControls, chapterId, readingMode])

  useEffect(() => {
    return () => {
      if (desktopControlsHideTimeoutRef.current !== null) {
        window.clearTimeout(desktopControlsHideTimeoutRef.current)
      }
    }
  }, [])

  const work = useMemo(
    () => (comicQuery.data ? mapComicMetadataToWorkRecord(comicQuery.data) : null),
    [comicQuery.data]
  )
  const comicPreferences = comicPreferencesQuery.data?.[0]?.data ?? null

  const availableChapterLanguages = useMemo(() => {
    const languages = new Set<string>()
    for (const variant of chapterGraph.chapterVariants) {
      const languageCodes = Array.isArray(variant.data.languageCodes) ? variant.data.languageCodes : []
      for (const entry of languageCodes) {
        if (typeof entry !== "string") continue
        const normalized = normalizeLanguageCode(entry)
        if (normalized) languages.add(normalized)
      }

      if (typeof variant.data.language === 'string') {
        const normalized = normalizeLanguageCode(variant.data.language)
        if (normalized) languages.add(normalized)
      }
    }

    return [...languages].sort((left, right) => left.localeCompare(right))
  }, [chapterGraph.chapterVariants])

  const selectedChapterLanguage = useMemo(() => {
    const savedMode = chapterLanguageModeFromSettings(comicPreferences)
    if (savedMode === AUTO_LANGUAGE_MODE) return AUTO_LANGUAGE_MODE
    return availableChapterLanguages.includes(savedMode) ? savedMode : AUTO_LANGUAGE_MODE
  }, [availableChapterLanguages, comicPreferences])

  const chapterLanguagePriority = useMemo(() => {
    if (selectedChapterLanguage !== AUTO_LANGUAGE_MODE) {
      return selectedChapterLanguage ? [selectedChapterLanguage] : []
    }

    const appPreferred = preferredLanguageCodes()
    const remaining = availableChapterLanguages.filter((language) => {
      const normalized = normalizeLanguageCode(language)
      return !appPreferred.includes(normalized)
    })

    return Array.from(new Set([...appPreferred, ...remaining]))
  }, [availableChapterLanguages, selectedChapterLanguage])

  const strictLanguageFilter = selectedChapterLanguage !== AUTO_LANGUAGE_MODE

  const chapters = useMemo(
    () =>
      resolveChapterVariants(
        chapterGraph.canonicalChapters,
        chapterGraph.chapterMappings,
        chapterGraph.chapterVariants,
        chapterLanguagePriority,
        strictLanguageFilter
      ),
    [
      chapterGraph.canonicalChapters,
      chapterGraph.chapterMappings,
      chapterGraph.chapterVariants,
      chapterLanguagePriority,
      strictLanguageFilter
    ]
  )

  const chapterIndex = useMemo(
    () =>
      chapters.findIndex((chapter) => {
        if (chapter.id === chapterId) return true
        return chapter.data.variantChapterId === chapterId
      }),
    [chapters, chapterId]
  )

  const currentChapter = chapterIndex >= 0 ? chapters[chapterIndex] : null
  const currentChapterAvailableLanguages = useMemo(() => {
    const languages = new Set<string>()
    const available = Array.isArray(currentChapter?.data.availableLanguageCodes)
      ? currentChapter.data.availableLanguageCodes
      : []
    const direct = Array.isArray(currentChapter?.data.languageCodes) ? currentChapter.data.languageCodes : []
    const currentLanguage = typeof currentChapter?.data.language === 'string' ? [currentChapter.data.language] : []
    const rawRecord =
      currentChapter?.data.raw && typeof currentChapter.data.raw === 'object'
        ? (currentChapter.data.raw as Record<string, unknown>)
        : null
    const rawLanguages = rawRecord
      ? [
          rawRecord.language,
          rawRecord.lang,
          ...(Array.isArray(rawRecord.languageCodes) ? rawRecord.languageCodes : [])
        ]
      : []

    for (const entry of [...available, ...direct, ...currentLanguage, ...rawLanguages]) {
      if (typeof entry !== 'string') continue
      const normalized = normalizeLanguageCode(entry)
      if (normalized) languages.add(normalized)
    }

    return [...languages].sort((left, right) => left.localeCompare(right))
  }, [currentChapter])
  const currentVariantChapterId =
    typeof currentChapter?.data.variantChapterId === 'string' ? currentChapter.data.variantChapterId : undefined
  const metadataPages = useMemo<ResolvedPage[]>(
    () => normalizeChapterPages(currentChapter?.data.pages),
    [currentChapter?.id, currentChapter?.data.pages]
  )
  const libraryChapterPagesQuery = useLibraryChapterPagesQuery(
    comicId,
    metadataPages.length === 0 && currentChapter ? currentChapter.id : null
  )
  const currentChapterPluginId =
    typeof currentChapter?.data.pluginId === 'string' && currentChapter.data.pluginId.trim()
      ? currentChapter.data.pluginId.trim()
      : ''
  const currentChapterSiteId =
    typeof currentChapter?.data.siteId === 'string' && currentChapter.data.siteId.trim()
      ? currentChapter.data.siteId.trim()
      : typeof currentChapter?.data.sourceId === 'string' && currentChapter.data.sourceId.trim()
        ? currentChapter.data.sourceId.trim()
        : ''
  const pageFetchRequestKey = useMemo(() => {
    if (!comicId || !currentChapter || !currentChapterPluginId || !currentChapterSiteId) return ''
    const chapterKey = currentVariantChapterId || currentChapter.id
    return `${comicId}:${chapterKey}:${currentChapterPluginId}:${currentChapterSiteId}`
  }, [comicId, currentChapter, currentVariantChapterId, currentChapterPluginId, currentChapterSiteId])
  const runtimePageEntry = useChapterPageFetchStore((state) =>
    pageFetchRequestKey ? state.entries[pageFetchRequestKey] : undefined
  )
  const fetchPagesForChapter = useChapterPageFetchStore((state) => state.fetchPagesForChapter)
  const libraryResolvedPages = useMemo<ResolvedPage[]>(() => {
    if (!libraryChapterPagesQuery.data?.pages) return []
    return normalizeChapterPages(
      libraryChapterPagesQuery.data.pages.map((page) => ({
        ...page,
        url: absolutizeApiPath(page.url)
      }))
    )
  }, [libraryChapterPagesQuery.data?.pages])
  const runtimePages = runtimePageEntry?.status === 'success' ? runtimePageEntry.pages : []
  const pages =
    metadataPages.length > 0
      ? metadataPages
      : libraryResolvedPages.length > 0
        ? libraryResolvedPages
        : runtimePages
  const legacyReadProgressQuery = useDbFindQuery<ReadProgressData>(
    'read_progress',
    'chapterId',
    currentVariantChapterId ?? '',
    1,
    Boolean(currentVariantChapterId && currentVariantChapterId !== chapterId)
  )
  const totalPages = pages.length

  useEffect(() => {
    if (!pageFetchRequestKey || metadataPages.length > 0 || libraryResolvedPages.length > 0) return
    if (!currentChapterPluginId || !currentChapterSiteId) return
    if (runtimePageEntry?.status === 'loading' || runtimePageEntry?.status === 'success') return

    void fetchPagesForChapter({
      requestKey: pageFetchRequestKey,
      pluginId: currentChapterPluginId,
      chapterSiteId: currentChapterSiteId
    })
  }, [
    pageFetchRequestKey,
    metadataPages.length,
    libraryResolvedPages.length,
    currentChapterPluginId,
    currentChapterSiteId,
    runtimePageEntry?.status,
    fetchPagesForChapter
  ])

  const chapterPagesQuery = useMemo(
    () => ({
      isLoading:
        comicQuery.isLoading ||
        comicQuery.isFetching ||
        libraryChapterPagesQuery.isLoading ||
        libraryChapterPagesQuery.isFetching ||
        runtimePageEntry?.status === 'loading',
      isError:
        comicQuery.isError ||
        libraryChapterPagesQuery.isError ||
        runtimePageEntry?.status === 'error'
    }),
    [
      comicQuery.isLoading,
      comicQuery.isFetching,
      comicQuery.isError,
      libraryChapterPagesQuery.isLoading,
      libraryChapterPagesQuery.isFetching,
      libraryChapterPagesQuery.isError,
      runtimePageEntry?.status
    ]
  )
  const safePage = useMemo(() => {
    const page = readProgress?.page ?? 1
    return Math.max(1, Math.min(page, Math.max(1, totalPages || 1)))
  }, [readProgress?.page, totalPages])

  const chapterName =
    (typeof currentChapter?.data.name === 'string' && currentChapter.data.name) ||
    (typeof currentChapter?.data.number === 'string' && currentChapter.data.number) ||
    chapterId ||
    '-'

  const comicName =
    (typeof work?.data.title === 'string' && work.data.title) ||
    (typeof work?.data.name === 'string' && work.data.name) ||
    comicId ||
    'Reader'
  const canUseDoublePageSpread = doublePageSpread && !isMobileViewport
  const canUseCustomZoom = !isMobileViewport && readingMode === 'horizontal'
  const isResolvingHorizontalLayout = useMemo(() => {
    if (readingMode !== 'horizontal' || !canUseDoublePageSpread || pages.length === 0) {
      return false
    }

    return pages.some((_, index) => !pageAspectMap[index])
  }, [readingMode, canUseDoublePageSpread, pages, pageAspectMap])

  const persistWorkSettings = useCallback(
    async (
      nextMode: 'horizontal' | 'vertical',
      nextDirection: 'ltr' | 'rtl',
      nextDoublePageSpread: boolean
    ) => {
      if (!comicId) return
      await upsertAppStateMutation.mutateAsync({
        table: 'app_state',
        data: {
          scopeId: comicId,
          readingMode: nextMode,
          readingDirection: nextDirection,
          doublePageSpread: nextDoublePageSpread,
          chapterLanguageMode: chapterLanguageModeFromSettings(comicPreferences)
        },
        id: `comic-preferences:${comicId}`
      })
      queryClient.invalidateQueries({ queryKey: restQueryKeys.dbFind('app_state', 'scopeId', comicId, 1) })
    },
    [comicId, comicPreferences, upsertAppStateMutation, queryClient]
  )
  const setChapterLanguageModeAndPersist = useCallback(
    async (nextLanguage: string) => {
      if (!comicId) return
      const nextMode =
        nextLanguage && nextLanguage !== AUTO_LANGUAGE_MODE
          ? normalizeLanguageCode(nextLanguage)
          : AUTO_LANGUAGE_MODE
      const queryKey = restQueryKeys.dbFind('app_state', 'scopeId', comicId, 1)
      const previous = queryClient.getQueryData<Array<{ id: string; created_at: string; updated_at: string; data: ComicPreferencesData }>>(queryKey)
      queryClient.setQueryData(queryKey, [
        {
          id: `comic-preferences:${comicId}`,
          created_at: previous?.[0]?.created_at ?? '',
          updated_at: previous?.[0]?.updated_at ?? '',
          data: {
            ...(previous?.[0]?.data ?? {}),
            scopeId: comicId,
            chapterLanguageMode: nextMode
          }
        }
      ])

      try {
        await upsertAppStateMutation.mutateAsync({
          table: 'app_state',
          id: `comic-preferences:${comicId}`,
          data: {
            scopeId: comicId,
            chapterLanguageMode: nextMode
          }
        })
        await queryClient.invalidateQueries({ queryKey })
      } catch (error) {
        queryClient.setQueryData(queryKey, previous)
        throw error
      }
    },
    [comicId, queryClient, upsertAppStateMutation]
  )

  const persistReadProgress = useCallback(
    async (next: ReadProgressData) => {
      const persistedReadProgress = await upsertReadProgressMutation.mutateAsync({
        table: 'read_progress',
        data: next,
        id: readProgressRecordIdRef.current ?? next.chapterId
      })
      readProgressRecordIdRef.current = persistedReadProgress.id
      queryClient.setQueryData(
        restQueryKeys.dbFind('read_progress', 'chapterId', next.chapterId, 1),
        [persistedReadProgress]
      )
      void queryClient.invalidateQueries({
        queryKey: restQueryKeys.dbFind('read_progress', 'comicId', next.comicId, 5000)
      })

      lastPersistedRef.current = { chapterId: next.chapterId, page: next.page }
    },
    [upsertReadProgressMutation, queryClient]
  )

  useEffect(() => {
    persistReadProgressRef.current = persistReadProgress
  }, [persistReadProgress])

  useEffect(() => {
    if (!comicId) {
      navigate('/', { replace: true })
    }
  }, [comicId, navigate])

  useEffect(() => {
    if (!comicId || !chapterId || !currentChapter) return
    if (currentChapter.id === chapterId) return
    if (currentChapter.data.variantChapterId !== chapterId) return

    navigate(`/reader/${comicId}/${currentChapter.id}`, { replace: true })
  }, [comicId, chapterId, currentChapter, navigate])

  useEffect(() => {
    const savedMode = comicPreferences?.readingMode
    const savedDirection = comicPreferences?.readingDirection
    const savedDoublePageSpread = comicPreferences?.doublePageSpread

    setReadingMode(savedMode === 'vertical' ? 'vertical' : 'horizontal')
    setReadingDirection(savedDirection === 'rtl' ? 'rtl' : 'ltr')
    setDoublePageSpread(savedDoublePageSpread === true)
  }, [comicPreferences?.readingMode, comicPreferences?.readingDirection, comicPreferences?.doublePageSpread])

  useEffect(() => {
    setReadProgress(null)
    readProgressRecordIdRef.current = undefined
    lastPersistedRef.current = null
    initialVerticalSyncChapterRef.current = null
    pendingVerticalSyncRef.current = false
    if (verticalScrollDebounceRef.current !== null) {
      window.clearTimeout(verticalScrollDebounceRef.current)
      verticalScrollDebounceRef.current = null
    }
    setPageAspectMap({})
  }, [chapterId])

  useEffect(() => {
    const needsLegacyReadProgress =
      Boolean(currentVariantChapterId) && currentVariantChapterId !== chapterId
    const legacyReadProgressReady = !needsLegacyReadProgress || legacyReadProgressQuery.isSuccess

    if (
      !chapterId ||
      !comicId ||
      !totalPages ||
      !readProgressQuery.isSuccess ||
      !legacyReadProgressReady ||
      readProgressQuery.fetchStatus !== 'idle'
    ) {
      return
    }

    if (readProgress?.chapterId === chapterId) return

    const record = readProgressQuery.data[0] ?? legacyReadProgressQuery.data?.[0]
    if (record?.data) {
      readProgressRecordIdRef.current = record.id
      const page = Math.max(1, Math.min(record.data.page || 1, totalPages))

      const nextProgress: ReadProgressData = {
        ...record.data,
        chapterId,
        comicId,
        totalPages,
        page
      }
      setReadProgress(nextProgress)
      lastPersistedRef.current = { chapterId, page }
      if (!readProgressQuery.data[0]) {
        void persistReadProgressRef.current(nextProgress)
      }
      return
    }

    const initial: ReadProgressData = {
      chapterId,
      comicId,
      page: 1,
      totalPages
    }
    setReadProgress(initial)
    lastPersistedRef.current = { chapterId, page: 1 }
    void persistReadProgressRef.current(initial)
  }, [
    chapterId,
    comicId,
    totalPages,
    currentVariantChapterId,
    readProgressQuery.isSuccess,
    legacyReadProgressQuery.isSuccess,
    readProgressQuery.fetchStatus,
    readProgressQuery.data,
    legacyReadProgressQuery.data,
    readProgress?.chapterId
  ])

  useEffect(() => {
    if (!chapterId && chapters.length && comicId) {
      navigate(`/reader/${comicId}/${chapters[0].id}`, { replace: true })
    }
  }, [chapterId, chapters, comicId, navigate])

  const setCurrentPage = useCallback(
    (page: number, options?: { syncScroll?: boolean; syncBehavior?: ScrollBehavior }) => {
      if (!chapterId || !comicId || !totalPages || !readProgress) return
      const nextPage = Math.max(1, Math.min(page, totalPages))
      if (nextPage === readProgress.page) return

      pendingVerticalSyncRef.current = Boolean(options?.syncScroll) && readingMode === 'vertical'
      if (pendingVerticalSyncRef.current) {
        pendingVerticalScrollBehaviorRef.current = options?.syncBehavior ?? 'auto'
      }
      setReadProgress({
        chapterId,
        comicId,
        page: nextPage,
        totalPages
      })
    },
    [chapterId, comicId, totalPages, readProgress, readingMode]
  )

  const horizontalSlides = useMemo<HorizontalReaderSlide[]>(() => {
    if (!pages.length) return []

    const orderedIndexes = Array.from({ length: pages.length }, (_, idx) => idx)

    const slides: HorizontalReaderSlide[] = []

    for (let pointer = 0; pointer < orderedIndexes.length; ) {
      const currentIndex = orderedIndexes[pointer]
      const nextIndex = pointer + 1 < orderedIndexes.length ? orderedIndexes[pointer + 1] : null

      const canPair =
        canUseDoublePageSpread &&
        nextIndex !== null &&
        pageAspectMap[currentIndex] === 'portrait' &&
        pageAspectMap[nextIndex] === 'portrait'

      const slideIndexes = canPair ? [currentIndex, nextIndex] : [currentIndex]
      const displayIndexes =
        canPair && readingDirection === 'rtl' ? [...slideIndexes].reverse() : slideIndexes

      const pagesForSlide = displayIndexes.map((originalIndex) => {
        const page = pages[originalIndex]
        const src = normalizeImageSrc(page.url)
        return {
          key: `${page.fileName}-${originalIndex}`,
          src,
          alt: `Page ${originalIndex + 1}`,
          originalIndex
        }
      })

      slides.push({
        key: pagesForSlide.map((item) => item.key).join('|'),
        pages: pagesForSlide
      })

      pointer += canPair ? 2 : 1
    }

    return slides
  }, [pages, readingDirection, canUseDoublePageSpread, pageAspectMap])

  const getHorizontalSlideAnchorIndex = useCallback(
    (slide: HorizontalReaderSlide | undefined): number | null => {
      if (!slide || slide.pages.length === 0) return null
      const anchorPage =
        readingDirection === 'rtl' ? slide.pages[slide.pages.length - 1] : slide.pages[0]
      return anchorPage?.originalIndex ?? null
    },
    [readingDirection]
  )

  const currentOriginalIndex = useMemo(
    () => Math.max(0, Math.min(safePage - 1, Math.max(0, pages.length - 1))),
    [safePage, pages.length]
  )

  const currentHorizontalSlideIndex = useMemo(() => {
    if (!horizontalSlides.length) return 0
    const idx = horizontalSlides.findIndex((slide) =>
      slide.pages.some((item) => item.originalIndex === currentOriginalIndex)
    )
    return idx >= 0 ? idx : 0
  }, [horizontalSlides, currentOriginalIndex])

  const displayedHorizontalPages = horizontalSlides[currentHorizontalSlideIndex]?.pages ?? []

  const verticalOrderedPages = useMemo(() => {
    const ordered = readingDirection === 'rtl' ? [...pages].reverse() : pages
    return ordered.map((page, index) => {
      const src = normalizeImageSrc(page.url)
      return {
        key: `${page.fileName}-${index}`,
        src,
        alt: `Page ${index + 1}`
      }
    })
  }, [pages, readingDirection])

  const goToChapter = useCallback(
    (index: number) => {
      if (
        readProgress &&
        (lastPersistedRef.current?.chapterId !== readProgress.chapterId ||
          lastPersistedRef.current?.page !== readProgress.page)
      ) {
        void persistReadProgressRef.current(readProgress)
      }

      if (!comicId) return
      if (index < 0 || index >= chapters.length) {
        navigate('/')
        return
      }
      navigate(`/reader/${comicId}/${chapters[index].id}`)
    },
    [chapters, comicId, navigate, readProgress]
  )

  const goToPreviousPage = useCallback(() => {
    if (!readProgress) return

    if (readingMode === 'horizontal') {
      if (currentHorizontalSlideIndex > 0) {
        const previousSlide = horizontalSlides[currentHorizontalSlideIndex - 1]
        const targetOriginalIndex = getHorizontalSlideAnchorIndex(previousSlide)
        if (targetOriginalIndex === null) return
        setCurrentPage(targetOriginalIndex + 1)
        return
      }
      goToChapter(chapterIndex - 1)
      return
    }

    if (readProgress.page > 1) {
      setCurrentPage(readProgress.page - 1, { syncScroll: true, syncBehavior: 'smooth' })
      return
    }

    goToChapter(chapterIndex - 1)
  }, [
    readProgress,
    readingMode,
    readingDirection,
    currentHorizontalSlideIndex,
    horizontalSlides,
    getHorizontalSlideAnchorIndex,
    setCurrentPage,
    goToChapter,
    chapterIndex
  ])

  const goToNextPage = useCallback(() => {
    if (!readProgress) return

    if (readingMode === 'horizontal') {
      if (currentHorizontalSlideIndex < horizontalSlides.length - 1) {
        const nextSlide = horizontalSlides[currentHorizontalSlideIndex + 1]
        const targetOriginalIndex = getHorizontalSlideAnchorIndex(nextSlide)
        if (targetOriginalIndex === null) return
        setCurrentPage(targetOriginalIndex + 1)
        return
      }
      goToChapter(chapterIndex + 1)
      return
    }

    if (readProgress.page < readProgress.totalPages) {
      setCurrentPage(readProgress.page + 1, { syncScroll: true, syncBehavior: 'smooth' })
      return
    }

    goToChapter(chapterIndex + 1)
  }, [
    readProgress,
    readingMode,
    readingDirection,
    currentHorizontalSlideIndex,
    horizontalSlides,
    getHorizontalSlideAnchorIndex,
    setCurrentPage,
    goToChapter,
    chapterIndex
  ])

  useEffect(() => {
    return () => {
      if (persistDebounceRef.current !== null) {
        window.clearTimeout(persistDebounceRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!readProgress) return

    if (
      lastPersistedRef.current?.chapterId === readProgress.chapterId &&
      lastPersistedRef.current?.page === readProgress.page
    ) {
      return
    }

    if (persistDebounceRef.current !== null) {
      window.clearTimeout(persistDebounceRef.current)
    }

    const snapshot = { ...readProgress }
    persistDebounceRef.current = window.setTimeout(() => {
      void persistReadProgressRef.current(snapshot)
    }, 160)
  }, [readProgress])

  useEffect(() => {
    return () => {
      if (
        readProgress &&
        (lastPersistedRef.current?.chapterId !== readProgress.chapterId ||
          lastPersistedRef.current?.page !== readProgress.page)
      ) {
        void persistReadProgressRef.current(readProgress)
      }
    }
  }, [readProgress])

  useEffect(() => {
    if (readingMode !== 'horizontal' || !horizontalViewportNode) return

    const viewport = horizontalViewportNode
    const updateWidth = () => setHorizontalViewportWidth(viewport.clientWidth)

    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(viewport)
    window.addEventListener('resize', updateWidth)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateWidth)
    }
  }, [readingMode, chapterId, horizontalViewportNode])

  useEffect(() => {
    if (!pages.length || readingMode !== 'horizontal') return

    const missingPages = pages
      .map((page, index) => ({ index, url: page.url }))
      .filter(({ index, url }) => !pageAspectMap[index] && Boolean(url))

    if (!missingPages.length) return

    let cancelled = false

    const resolveAspect = (index: number, url: string): Promise<{ index: number; aspect: 'portrait' | 'landscape' } | null> =>
      new Promise((resolve) => {
        const img = new Image()
        img.onload = () => {
          resolve({
            index,
            aspect: img.naturalHeight >= img.naturalWidth ? 'portrait' : 'landscape'
          })
        }
        img.onerror = () => resolve(null)
        img.src = url
      })

    void Promise.all(missingPages.map(({ index, url }) => resolveAspect(index, url))).then((resolved) => {
      if (cancelled) return
      setPageAspectMap((current) => {
        let changed = false
        const next = { ...current }
        for (const entry of resolved) {
          if (!entry || next[entry.index]) continue
          next[entry.index] = entry.aspect
          changed = true
        }
        return changed ? next : current
      })
    })

    return () => {
      cancelled = true
    }
  }, [pages, readingMode, pageAspectMap])

  useEffect(() => {
    if (readingMode !== 'vertical' || !verticalScrollContainerNode || !readProgress || !pages.length)
      return
    if (!isMobileViewport && verticalDesktopPageHeight <= 0) return

    const isInitialSync = initialVerticalSyncChapterRef.current !== chapterId
    if (!isInitialSync && !pendingVerticalSyncRef.current) return

    const container = verticalScrollContainerNode
    const targetIndex = Math.max(0, Math.min(safePage - 1, pages.length - 1))
    const targetNode = verticalPageRefs.current[targetIndex]
    if (!targetNode) return
    const targetTop = targetNode ? Math.max(0, targetNode.offsetTop) : 0
    const behavior = pendingVerticalScrollBehaviorRef.current

    pendingVerticalSyncRef.current = false
    pendingVerticalScrollBehaviorRef.current = 'auto'
    if (isInitialSync) {
      initialVerticalSyncChapterRef.current = chapterId ?? null
    }

    setIsScrollingProgrammatically(true)
    container.scrollTo({ top: targetTop, behavior })

    const timeout = window.setTimeout(() => setIsScrollingProgrammatically(false), 220)
    return () => window.clearTimeout(timeout)
  }, [
    readingMode,
    verticalScrollContainerNode,
    readProgress,
    safePage,
    chapterId,
    pages.length,
    isMobileViewport,
    verticalDesktopPageHeight
  ])

  useEffect(() => {
    if (readingMode !== 'vertical' || !verticalScrollContainerNode || !pages.length) return

    const container = verticalScrollContainerNode
    const computeCurrentPage = () => {
      if (isScrollingProgrammatically) return
      if (!container.clientHeight) return

      let pageIndex = 0
      if (!isMobileViewport) {
        pageIndex = Math.round(container.scrollTop / container.clientHeight)
      } else {
        const centerY = container.scrollTop + container.clientHeight / 2
        let bestDistance = Number.POSITIVE_INFINITY
        let bestIndex = 0
        for (let index = 0; index < pages.length; index += 1) {
          const node = verticalPageRefs.current[index]
          if (!node) continue
          const pageCenter = node.offsetTop + node.clientHeight / 2
          const distance = Math.abs(pageCenter - centerY)
          if (distance < bestDistance) {
            bestDistance = distance
            bestIndex = index
          }
        }
        pageIndex = bestIndex
      }

      const page = Math.max(1, Math.min(pageIndex + 1, pages.length))
      pendingVerticalSyncRef.current = false
      setCurrentPage(page)
    }

    const handleScroll = () => {
      if (isScrollingProgrammatically) return
      if (verticalScrollDebounceRef.current !== null) {
        window.clearTimeout(verticalScrollDebounceRef.current)
      }
      verticalScrollDebounceRef.current = window.setTimeout(computeCurrentPage, 180)
    }

    container.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      container.removeEventListener('scroll', handleScroll)
      if (verticalScrollDebounceRef.current !== null) {
        window.clearTimeout(verticalScrollDebounceRef.current)
        verticalScrollDebounceRef.current = null
      }
    }
  }, [
    readingMode,
    verticalScrollContainerNode,
    pages.length,
    setCurrentPage,
    isScrollingProgrammatically,
    isMobileViewport
  ])

  useEffect(() => {
    if (readingMode !== 'vertical' || isMobileViewport || !verticalScrollContainerNode) return

    const container = verticalScrollContainerNode
    const updateHeight = () => setVerticalDesktopPageHeight(container.clientHeight)

    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(container)
    window.addEventListener('resize', updateHeight)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateHeight)
    }
  }, [readingMode, isMobileViewport, chapterId, verticalScrollContainerNode])

  useEffect(() => {
    const container = mainContainerRef.current
    if (!container) return

    const handleWheel = (event: WheelEvent) => {
      if (readingMode === 'horizontal') {
        event.preventDefault()
      }
    }

    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [readingMode])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault()
      }

      if (event.key === 'Escape') {
        navigate('/')
        return
      }

      const useRtlHorizontalKeys = readingMode === 'horizontal' && readingDirection === 'rtl'

      if (event.key === 'ArrowLeft') {
        if (useRtlHorizontalKeys) {
          goToNextPage()
        } else {
          goToPreviousPage()
        }
      }

      if (event.key === 'ArrowRight') {
        if (useRtlHorizontalKeys) {
          goToPreviousPage()
        } else {
          goToNextPage()
        }
      }

      if (event.key === 'ArrowUp' && readingMode === 'vertical') {
        goToPreviousPage()
      }

      if (event.key === 'ArrowDown' && readingMode === 'vertical') {
        goToNextPage()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [readingMode, readingDirection, goToPreviousPage, goToNextPage, navigate])

  const setReadingModeAndPersist = async (vertical: boolean) => {
    const next = vertical ? 'vertical' : 'horizontal'
    if (next === readingMode) return

    setReadingMode(next)
    if (next === 'vertical') {
      setZoomVisible(false)
      pendingVerticalSyncRef.current = true
    }
    await persistWorkSettings(next, readingDirection, doublePageSpread)
  }

  const setReadingDirectionAndPersist = async (rtl: boolean) => {
    const next = rtl ? 'rtl' : 'ltr'
    if (next === readingDirection) return
    setReadingDirection(next)
    await persistWorkSettings(readingMode, next, doublePageSpread)
  }

  const setDoublePageSpreadAndPersist = async (enabled: boolean) => {
    const next = Boolean(enabled)
    if (next === doublePageSpread) return
    setDoublePageSpread(next)
    await persistWorkSettings(readingMode, readingDirection, next)
  }

  const currentZoomImageKey = useMemo(() => {
    if (!chapterId || !pages.length) return ''
    if (readingMode === 'horizontal') {
      return displayedHorizontalPages.map((page) => page.key).join('|')
    }
    return `${chapterId}:${safePage}`
  }, [chapterId, pages.length, readingMode, displayedHorizontalPages, safePage])

  const externalChapterUrl =
    !pages.length
      && runtimePageEntry?.status !== 'loading'
      && runtimePageEntry?.status !== 'error'
      ? typeof currentChapter?.data.siteLink === 'string' && currentChapter.data.siteLink.trim()
        ? currentChapter.data.siteLink.trim()
        : null
      : null

  const openExternalChapter = useCallback(() => {
    if (!externalChapterUrl) return
    window.open(externalChapterUrl, '_blank', 'noopener,noreferrer')
  }, [externalChapterUrl])

  return {
    chapterPagesQuery,
    isResolvingPages: runtimePageEntry?.status === 'loading' || isResolvingHorizontalLayout,
    comicName,
    chapterName,
    currentChapterAvailableLanguages,
    selectedChapterLanguage,
    autoLanguageMode: AUTO_LANGUAGE_MODE,
    readingMode,
    readingDirection,
    canUseDoublePageSpread,
    isMobileViewport,
    setReadingModeAndPersist,
    setReadingDirectionAndPersist,
    setDoublePageSpreadAndPersist,
    setChapterLanguageModeAndPersist,
    onClose: () => navigate('/'),
    desktopControlsVisible,
    showDesktopControls,
    mainContainerRef,
    canUseCustomZoom,
    zoomVisible,
    setZoomVisible,
    currentZoomImageKey,
    externalChapterUrl,
    openExternalChapter,
    pages,
    horizontalSlides,
    currentHorizontalSlideIndex,
    horizontalViewportWidth,
    setHorizontalViewportRef,
    goToPreviousPage,
    goToNextPage,
    verticalOrderedPages,
    verticalDesktopPageHeight,
    setVerticalScrollContainerRef,
    verticalPageRefs,
    safePage,
    totalPages,
    goToPreviousChapter: () => goToChapter(chapterIndex - 1),
    goToNextChapter: () => goToChapter(chapterIndex + 1),
    hasPreviousChapter: chapterIndex > 0,
    hasNextChapter: chapterIndex < chapters.length - 1
  }
}
