import { ComponentProps, FC, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useOpenWindow } from '@pablovsouza/react-window-manager'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import i18n from 'i18n'
import { BgBox } from 'components'
import {
  buildComicChapterGraph,
  type ComicMetadata,
  type CanonicalChapterData,
  type ChapterMappingData,
  type ChapterVariantData,
  type DbRecord,
  getComicCoverUrl,
  type LibraryListItem,
  mapComicMetadataToWorkRecord,
  restQueryKeys,
  type WorkData,
  resolveChapterVariants,
  useDownloadLibraryChaptersOfflineMutation,
  useDbUpsertMutation,
  useDbFindQuery,
  useDbListQuery,
  useLibraryComicQuery
} from 'services'
import { cn } from 'utils'
import { listInstalledPlugins, refreshComicChaptersFromSources, type PluginRecordData } from 'windows/SearchContentWindow/pluginApi'
import { MainContentHeader } from './MainContentHeader'
import { MainContentNav } from './MainContentNav'
import { MainContentChapterTable } from './MainContentChapterTable'

interface MainContentProps extends ComponentProps<'div'> {
  selectedWorkId?: string | null
}

const normalizeText = (value: unknown): string | undefined => {
  return typeof value === 'string' && value.trim().length ? value : undefined
}

const AUTO_LANGUAGE_MODE = '__auto__'

const normalizeLanguageCode = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase().replace(/_/g, '-')
}

const preferredAppLanguageCodes = (): string[] => {
  const resolved = normalizeLanguageCode(i18n.resolvedLanguage || i18n.language || 'en')
  const base = resolved.split('-')[0]
  const all = [resolved, base]

  if (base === 'pt') {
    all.push(resolved === 'pt-pt' ? 'pt-br' : 'pt-pt')
  }

  return Array.from(new Set(all.filter(Boolean)))
}

const preferredUiLanguageCodes = (): string[] => {
  return preferredAppLanguageCodes()
}

interface ReadProgressData {
  chapterId?: string
  comicId?: string
  page?: number
  totalPages?: number
  [key: string]: unknown
}

interface ComicPreferencesData {
  scopeId?: string
  chapterLanguageMode?: string
  [key: string]: unknown
}

const progressPercentFromReadProgress = (readProgress?: ReadProgressData): number => {
  if (!readProgress) return 0
  const totalPages = typeof readProgress.totalPages === 'number' ? readProgress.totalPages : 0
  const page = typeof readProgress.page === 'number' ? readProgress.page : 0
  if (totalPages <= 0) return 0
  const safePage = Math.max(0, Math.min(page, totalPages))
  return Math.max(0, Math.min(100, Math.round((safePage / totalPages) * 100)))
}

const hasOfflineFile = (offline: { available?: boolean | null; cbzFile?: string | null } | null | undefined) => {
  return offline?.available === true || (typeof offline?.cbzFile === 'string' && offline.cbzFile.trim().length > 0)
}

export const MainContent: FC<MainContentProps> = ({
  className,
  selectedWorkId,
  ...props
}) => {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const openWindow = useOpenWindow()
  const navigate = useNavigate()
  const comicQuery = useLibraryComicQuery(selectedWorkId)
  const comicPreferencesQuery = useDbFindQuery<ComicPreferencesData>(
    'app_state',
    'scopeId',
    selectedWorkId ?? '',
    1,
    Boolean(selectedWorkId)
  )
  const upsertAppStateMutation = useDbUpsertMutation<ComicPreferencesData>()
  const downloadOfflineMutation = useDownloadLibraryChaptersOfflineMutation()
  const pluginsQuery = useDbListQuery<PluginRecordData>('plugins', 500, 0)
  const readProgressQuery = useDbFindQuery<ReadProgressData>(
    'read_progress',
    'comicId',
    selectedWorkId ?? '',
    5000,
    Boolean(selectedWorkId)
  )
  const [selectedChapterIds, setSelectedChapterIds] = useState<Set<string>>(new Set())
  const [pendingOfflineChapterIds, setPendingOfflineChapterIds] = useState<Set<string>>(new Set())
  const [isSelectionMode, setIsSelectionMode] = useState(false)
  const [selectedChapterLanguage, setSelectedChapterLanguage] = useState<string>(AUTO_LANGUAGE_MODE)
  const [isRefreshingChapters, setIsRefreshingChapters] = useState(false)

  const chapterGraph = useMemo(() => {
    if (!comicQuery.data) {
      return {
        work: null,
        canonicalChapters: [] as Array<DbRecord<CanonicalChapterData>>,
        chapterVariants: [] as Array<DbRecord<ChapterVariantData>>,
        chapterMappings: [] as Array<DbRecord<ChapterMappingData>>
      }
    }
    return buildComicChapterGraph(comicQuery.data)
  }, [comicQuery.data])

  const selectedWork = useMemo(
    () => (comicQuery.data ? mapComicMetadataToWorkRecord(comicQuery.data) : null),
    [comicQuery.data]
  )
  const installedPlugins = useMemo(
    () => listInstalledPlugins(pluginsQuery.data ?? []).filter((plugin) => plugin.enabled),
    [pluginsQuery.data]
  )

  const availableChapterLanguages = useMemo(() => {
    const languages = new Set<string>()
    for (const variant of chapterGraph.chapterVariants) {
      const raw = Array.isArray(variant.data.languageCodes) ? variant.data.languageCodes : []
      for (const entry of raw) {
        const normalized = normalizeLanguageCode(entry)
        if (normalized) languages.add(normalized)
      }
      const direct = normalizeLanguageCode(variant.data.language)
      if (direct) languages.add(direct)
    }
    return [...languages].sort((left, right) => left.localeCompare(right))
  }, [chapterGraph.chapterVariants])

  useEffect(() => {
    const savedMode = comicPreferencesQuery.data?.[0]?.data.chapterLanguageMode
    const normalizedSaved =
      typeof savedMode === 'string' && savedMode.trim() ? normalizeLanguageCode(savedMode) : AUTO_LANGUAGE_MODE
    if (availableChapterLanguages.length <= 1) {
      setSelectedChapterLanguage(
        normalizedSaved !== AUTO_LANGUAGE_MODE && availableChapterLanguages.includes(normalizedSaved)
          ? normalizedSaved
          : availableChapterLanguages[0] ?? AUTO_LANGUAGE_MODE
      )
      return
    }

    setSelectedChapterLanguage(() => {
      if (normalizedSaved !== AUTO_LANGUAGE_MODE && availableChapterLanguages.includes(normalizedSaved)) {
        return normalizedSaved
      }
      return AUTO_LANGUAGE_MODE
    })
  }, [availableChapterLanguages, comicPreferencesQuery.data, selectedWorkId])

  const handleSelectChapterLanguage = (nextLanguage: string) => {
    setSelectedChapterLanguage(nextLanguage)
    if (!selectedWorkId) return
    const nextMode =
      nextLanguage && nextLanguage !== AUTO_LANGUAGE_MODE
        ? normalizeLanguageCode(nextLanguage)
        : AUTO_LANGUAGE_MODE
    const queryKey = restQueryKeys.dbFind('app_state', 'scopeId', selectedWorkId, 1)
    const previous = queryClient.getQueryData<Array<DbRecord<ComicPreferencesData>>>(queryKey)
    queryClient.setQueryData<Array<DbRecord<ComicPreferencesData>>>(queryKey, [
      {
        id: `comic-preferences:${selectedWorkId}`,
        created_at: previous?.[0]?.created_at ?? '',
        updated_at: previous?.[0]?.updated_at ?? '',
        data: {
          ...(previous?.[0]?.data ?? {}),
          scopeId: selectedWorkId,
          chapterLanguageMode: nextMode
        }
      }
    ])

    void upsertAppStateMutation.mutateAsync({
      table: 'app_state',
      id: `comic-preferences:${selectedWorkId}`,
      data: {
        scopeId: selectedWorkId,
        chapterLanguageMode: nextMode
      }
    })
      .then(() =>
        queryClient.invalidateQueries({
          queryKey
        })
      )
      .catch(() => {
        queryClient.setQueryData(queryKey, previous)
      })
  }

  const chapterLanguagePriority = useMemo(() => {
    if (selectedChapterLanguage !== AUTO_LANGUAGE_MODE) {
      return selectedChapterLanguage ? [selectedChapterLanguage] : []
    }

    const appPreferred = preferredUiLanguageCodes()
    const englishPreferred = ['en']
    const remaining = availableChapterLanguages.filter((language) => {
      const normalized = normalizeLanguageCode(language)
      return !appPreferred.includes(normalized) && normalized !== 'en'
    })

    return Array.from(new Set([...appPreferred, ...englishPreferred, ...remaining]))
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
      chapterLanguagePriority,
      chapterGraph.chapterMappings,
      chapterGraph.chapterVariants,
      strictLanguageFilter
    ]
  )
  const chapterCountHint = useMemo(() => {
    const raw = selectedWork?.data?.chapterCount
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0
  }, [selectedWork?.data?.chapterCount])

  const chaptersWithFallback = useMemo(() => {
    const hasImportedVariants = chapterGraph.chapterVariants.length > 0
    if (chapters.length > 0 || !selectedWorkId || chapterCountHint <= 0 || hasImportedVariants) return chapters

    return Array.from({ length: chapterCountHint }, (_, index) => {
      const number = String(index + 1)
      return {
        id: `placeholder:${selectedWorkId}:${number}`,
        created_at: '',
        updated_at: '',
        data: {
          canonicalChapterId: `placeholder:${selectedWorkId}:${number}`,
          number,
          name: t('common.chapterLabel', { number }),
          pages: [],
          isPlaceholder: true
        }
      }
    })
  }, [chapterCountHint, chapterGraph.chapterVariants.length, chapters, selectedWorkId, t])
  const deferredChapters = useDeferredValue(chaptersWithFallback)
  const hasSelectedChapters = selectedChapterIds.size > 0

  const readProgressByChapterId = useMemo(() => {
    const map = new Map<string, number>()
    for (const record of readProgressQuery.data ?? []) {
      const chapterId = typeof record.data.chapterId === 'string' ? record.data.chapterId : undefined
      if (!chapterId) continue
      map.set(chapterId, progressPercentFromReadProgress(record.data))
    }
    return map
  }, [readProgressQuery.data])

  const progressForChapter = useMemo(
    () => (chapter: (typeof deferredChapters)[number]): number => {
      const chapterData = chapter.data as Record<string, unknown>
      const variantChapterId =
        typeof chapterData.variantChapterId === 'string' ? chapterData.variantChapterId : ''
      return (
        readProgressByChapterId.get(chapter.id) ??
        (variantChapterId ? readProgressByChapterId.get(variantChapterId) : undefined) ??
        0
      )
    },
    [readProgressByChapterId]
  )

  const preferredReaderChapterId = useMemo(() => {
    const lastChapterWithProgress = [...deferredChapters]
      .reverse()
      .find((chapter) => progressForChapter(chapter) > 0)

    return lastChapterWithProgress?.id ?? deferredChapters[0]?.id ?? null
  }, [deferredChapters, progressForChapter])
  const chapterVariantIdByResolvedId = useMemo(
    () =>
      new Map(
        deferredChapters.map((chapter) => {
          const chapterData = chapter.data as Record<string, unknown>
          return [
            chapter.id,
            typeof chapterData.variantChapterId === 'string' ? chapterData.variantChapterId : ''
          ] as const
        })
      ),
    [deferredChapters]
  )

  const totalProgress = useMemo(() => {
    if (!deferredChapters.length) return 0
    const total = deferredChapters.reduce(
      (sum, chapter) => sum + progressForChapter(chapter),
      0
    )
    return Math.round(total / deferredChapters.length)
  }, [deferredChapters, progressForChapter])

  useEffect(() => {
    setSelectedChapterIds(new Set())
    setIsSelectionMode(false)
    setPendingOfflineChapterIds(new Set())
  }, [selectedWorkId])

  if (!selectedWorkId) {
    return (
      <BgBox className={cn('relative min-h-0 overflow-auto p-4', className)} {...props}>
        <div className="rounded-md border border-border/50 bg-background p-3 text-sm text-muted-foreground">
          {t('mainContent.emptySelection')}
        </div>
      </BgBox>
    )
  }

  const workData = (selectedWork?.data ?? {}) as WorkData
  const title = normalizeText(workData.title) || normalizeText(workData.name) || selectedWorkId
  const publisher = normalizeText(workData.publisher)
  const status = normalizeText(workData.status) || t('mainContent.unknownStatus')
  const synopsis = normalizeText(workData.description) || normalizeText(workData.synopsis)
  const coverUrl = selectedWorkId ? getComicCoverUrl(selectedWorkId) : normalizeText(workData.cover)
  const showSelectionMode = isSelectionMode || hasSelectedChapters
  const handleMakeSelectedOffline = async (chapterIds: string[]) => {
    if (!selectedWorkId || !chapterIds.length) return

    const variantIds = Array.from(
      new Set(
        chapterIds
          .map((chapterId) => chapterVariantIdByResolvedId.get(chapterId) ?? '')
          .filter((value) => value.trim().length > 0)
      )
    )
    if (!variantIds.length) return

    const targetChapterIds = [...chapterIds]
    setPendingOfflineChapterIds((current) => {
      const next = new Set(current)
      targetChapterIds.forEach((chapterId) => next.add(chapterId))
      return next
    })
    setSelectedChapterIds(new Set())
    setIsSelectionMode(false)

    try {
      const result = await downloadOfflineMutation.mutateAsync({
        comicId: selectedWorkId,
        payload: { variantIds }
      })

      queryClient.setQueryData<ComicMetadata | undefined>(
        restQueryKeys.libraryComic(selectedWorkId),
        (current) => {
          if (!current) return current

          let nextOfflineCount = 0
          const nextChapters = current.chapters.map((chapter) => {
            let chapterHasOffline = false
            const nextVariants = chapter.variants.map((variant) => {
              if (!variantIds.includes(variant.id)) {
                if (hasOfflineFile(variant.offline)) chapterHasOffline = true
                return variant
              }

              const nextVariant = {
                ...variant,
                offline: {
                  ...(variant.offline ?? {}),
                  available: true
                }
              }
              if (hasOfflineFile(nextVariant.offline)) chapterHasOffline = true
              return nextVariant
            })

            if (!chapterHasOffline) {
              chapterHasOffline = nextVariants.some((variant) => hasOfflineFile(variant.offline))
            }
            if (chapterHasOffline) nextOfflineCount += 1

            return {
              ...chapter,
              variants: nextVariants
            }
          })

          queryClient.setQueryData<LibraryListItem[] | undefined>(restQueryKeys.library, (items) => {
            if (!items) return items
            return items.map((item) =>
              item.comicId === selectedWorkId
                ? {
                    ...item,
                    offlineChapterCount: nextOfflineCount
                  }
                : item
            )
          })

          return {
            ...current,
            chapters: nextChapters
          }
        }
      )

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: restQueryKeys.library }),
        queryClient.invalidateQueries({ queryKey: restQueryKeys.libraryComic(selectedWorkId) })
      ])
      setPendingOfflineChapterIds((current) => {
        const next = new Set(current)
        targetChapterIds.forEach((chapterId) => next.delete(chapterId))
        return next
      })

      toast.success(t('mainContent.chapterTable.bulk.makeOfflineSuccessTitle'), {
        description: t('mainContent.chapterTable.bulk.makeOfflineSuccessDescription', {
          downloaded: result.downloaded,
          skipped: result.skipped,
          failed: result.failed
        })
      })
      if (result.failed > 0) {
        toast.error(t('mainContent.chapterTable.bulk.makeOfflinePartialErrorTitle'), {
          description: t('mainContent.chapterTable.bulk.makeOfflinePartialErrorDescription', {
            failed: result.failed
          })
        })
      }
    } catch (error) {
      setPendingOfflineChapterIds((current) => {
        const next = new Set(current)
        targetChapterIds.forEach((chapterId) => next.delete(chapterId))
        return next
      })
      const description =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : t('mainContent.chapterTable.bulk.makeOfflineErrorDescription')
      toast.error(t('mainContent.chapterTable.bulk.makeOfflineErrorTitle'), {
        description
      })
    }
  }

  const handleRefreshChapters = async () => {
    if (!comicQuery.data || isRefreshingChapters) return

    setIsRefreshingChapters(true)
    const previousChapterCount = comicQuery.data.chapters.length

    try {
      const result = await refreshComicChaptersFromSources(comicQuery.data, installedPlugins)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: restQueryKeys.library }),
        queryClient.invalidateQueries({ queryKey: restQueryKeys.libraryComic(comicQuery.data.id) })
      ])
      const refreshedComic = (await comicQuery.refetch()).data as ComicMetadata | undefined
      const nextChapterCount = refreshedComic?.chapters.length ?? previousChapterCount
      const addedChapters = Math.max(0, nextChapterCount - previousChapterCount)

      toast.success(t('mainContent.nav.refresh.successTitle'), {
        description: t('mainContent.nav.refresh.successDescription', {
          sourcesChecked: result.sourcesChecked,
          sourcesUpdated: result.sourcesUpdated,
          addedChapters
        })
      })
    } catch (error) {
      const description =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : t('mainContent.nav.refresh.errorDescription')
      toast.error(t('mainContent.nav.refresh.errorTitle'), { description })
    } finally {
      setIsRefreshingChapters(false)
    }
  }

  return (
    <BgBox className={cn('relative min-h-0 overflow-hidden', className)} {...props}>
      <div
        className="grid h-full min-h-0 gap-px overflow-hidden"
        style={{ gridTemplateRows: '18rem 3rem minmax(0, 1fr)' }}
      >
        <MainContentHeader
          title={title}
          publisher={publisher}
          status={status}
          synopsis={synopsis}
          coverUrl={coverUrl}
        />
        <MainContentNav
          totalProgress={totalProgress}
          availableChapterLanguages={availableChapterLanguages}
          selectedChapterLanguage={selectedChapterLanguage}
          autoLanguageMode={AUTO_LANGUAGE_MODE}
          onSelectChapterLanguage={handleSelectChapterLanguage}
          isSelectionMode={showSelectionMode}
          onToggleSelectionMode={() => {
            if (showSelectionMode) {
              setSelectedChapterIds(new Set())
              setIsSelectionMode(false)
              return
            }
            setIsSelectionMode(true)
          }}
          onRead={() => {
            if (!selectedWorkId || !preferredReaderChapterId) return
            navigate(`/reader/${selectedWorkId}/${preferredReaderChapterId}`)
          }}
          onRefreshChapters={() => {
            void handleRefreshChapters()
          }}
          isRefreshingChapters={isRefreshingChapters}
          onLinkMetadata={() => {
            if (!selectedWorkId) return
            openWindow({
              component: 'SearchContentWindow',
              props: { targetComicId: selectedWorkId }
            })
          }}
          readDisabled={!preferredReaderChapterId}
        />
        <MainContentChapterTable
          entityId={selectedWorkId}
          chapters={deferredChapters}
          progressByChapterId={readProgressByChapterId}
          pendingOfflineChapterIds={pendingOfflineChapterIds}
          selectedIds={selectedChapterIds}
          setSelectedIds={setSelectedChapterIds}
          isSelectionMode={showSelectionMode}
          onExitSelectionMode={() => setIsSelectionMode(false)}
          onOpenChapter={(chapterId) => navigate(`/reader/${selectedWorkId}/${chapterId}`)}
          onMakeSelectedOffline={handleMakeSelectedOffline}
        />
      </div>
    </BgBox>
  )
}
