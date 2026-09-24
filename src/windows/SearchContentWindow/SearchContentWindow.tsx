import { FC, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Search, X } from 'lucide-react'
import { Input } from 'components/ui/input'
import { Button } from 'components/ui/button'
import { LoadingOverlay } from 'components'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger
} from 'components/ui/dropdown-menu'
import { useDbListQuery, useLibraryComicQuery, useLibraryListQuery, restQueryKeys } from 'services'
import {
  addSearchResultToDatabase,
  listInstalledPlugins,
  loadSearchResultDetails,
  PluginSearchError,
  PluginRecordData,
  searchByPlugins,
  type AddToDatabaseProgress,
  type SearchResultDetails,
  type SearchResultItem
} from './pluginApi'
import { SearchResultCard } from './SearchResultCard'

export interface SearchContentWindowProps extends Record<string, unknown> {
  closeSelf?: () => void
  targetComicId?: string
}

export const SearchContentWindow: FC<SearchContentWindowProps> = ({ closeSelf, targetComicId }) => {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const pluginsQuery = useDbListQuery<PluginRecordData>('plugins', 500, 0)
  const libraryQuery = useLibraryListQuery()
  const targetComicQuery = useLibraryComicQuery(targetComicId)

  const [query, setQuery] = useState('')
  const [selectedPluginIds, setSelectedPluginIds] = useState<string[]>([])
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchErrors, setSearchErrors] = useState<PluginSearchError[]>([])
  const [addingByResultId, setAddingByResultId] = useState<Record<string, boolean>>({})
  const [addProgressByResultId, setAddProgressByResultId] = useState<Record<string, AddToDatabaseProgress>>({})
  const [expandedResultId, setExpandedResultId] = useState<string | null>(null)
  const [detailsByResultId, setDetailsByResultId] = useState<Record<string, SearchResultDetails>>({})
  const [loadingDetailsByResultId, setLoadingDetailsByResultId] = useState<Record<string, boolean>>({})
  const searchDebounceRef = useRef<number | null>(null)

  const plugins = useMemo(
    () => listInstalledPlugins(pluginsQuery.data ?? []).filter((plugin) => plugin.enabled),
    [pluginsQuery.data]
  )

  const selectedPlugins = useMemo(() => {
    return plugins.filter((plugin) => selectedPluginIds.includes(plugin.id))
  }, [plugins, selectedPluginIds])

  useEffect(() => {
    if (plugins.length === 0) {
      setSelectedPluginIds([])
      return
    }
    setSelectedPluginIds((current) => {
      if (current.length > 0) {
        return current.filter((pluginId) => plugins.some((plugin) => plugin.id === pluginId))
      }
      return plugins.map((plugin) => plugin.id)
    })
  }, [plugins])

  const existingWorkSourceKeySet = useMemo(() => {
    const set = new Set<string>()
    for (const work of libraryQuery.data ?? []) {
      for (const sourceKey of work.sourceKeys ?? []) {
        if (sourceKey) set.add(sourceKey)
      }
    }
    return set
  }, [libraryQuery.data])

  const targetComicSourceKeySet = useMemo(() => {
    const set = new Set<string>()
    for (const source of targetComicQuery.data?.sources ?? []) {
      const tag = typeof source.pluginTag === 'string' ? source.pluginTag.trim() : ''
      const siteId = typeof source.sourceSiteId === 'string' ? source.sourceSiteId.trim() : ''
      if (tag && siteId) set.add(`${tag}:${siteId}`)
    }
    return set
  }, [targetComicQuery.data])

  const handleTogglePlugin = (pluginId: string) => {
    setSelectedPluginIds((current) =>
      current.includes(pluginId) ? current.filter((id) => id !== pluginId) : [...current, pluginId]
    )
  }

  const handleSearch = async (searchValue: string) => {
    if (!searchValue.trim()) {
      setResults([])
      setSearchErrors([])
      setExpandedResultId(null)
      setDetailsByResultId({})
      setLoadingDetailsByResultId({})
      return
    }

    if (selectedPlugins.length === 0) {
      setResults([])
      setSearchErrors([])
      return
    }
    setIsSearching(true)
    try {
      const { results: nextResults, errors } = await searchByPlugins(selectedPlugins, searchValue)
      setResults(nextResults)
      setSearchErrors(errors)
      setExpandedResultId(null)
      setDetailsByResultId({})
      setLoadingDetailsByResultId({})
    } finally {
      setIsSearching(false)
    }
  }

  useEffect(() => {
    if (searchDebounceRef.current) {
      window.clearTimeout(searchDebounceRef.current)
    }

    searchDebounceRef.current = window.setTimeout(() => {
      void handleSearch(query)
    }, 600)

    return () => {
      if (searchDebounceRef.current) {
        window.clearTimeout(searchDebounceRef.current)
      }
    }
  }, [query, selectedPlugins])

  const handleToggleResult = async (item: SearchResultItem) => {
    const isExpanded = expandedResultId === item.id
    if (isExpanded) {
      setExpandedResultId(null)
      return
    }

    setExpandedResultId(item.id)

    if (detailsByResultId[item.id] || loadingDetailsByResultId[item.id]) {
      return
    }

    setLoadingDetailsByResultId((current) => ({ ...current, [item.id]: true }))
    try {
      const details = await loadSearchResultDetails(item)
      setDetailsByResultId((current) => ({ ...current, [item.id]: details }))
    } finally {
      setLoadingDetailsByResultId((current) => ({ ...current, [item.id]: false }))
    }
  }

  const handleAddComic = async (item: SearchResultItem) => {
    setAddingByResultId((current) => ({ ...current, [item.id]: true }))
    setAddProgressByResultId((current) => ({
      ...current,
      [item.id]: {
        value: 0,
        message: t(targetComicId ? 'searchContent.actions.linking' : 'searchContent.actions.adding')
      }
    }))
    try {
      await addSearchResultToDatabase(item, selectedPlugins, {
        targetComicId,
        onProgress: (progress) => {
          setAddProgressByResultId((current) => ({
            ...current,
            [item.id]: {
              value: progress.value,
              message: progress.message ? t(progress.message) : undefined
            }
          }))
        }
      })
      await queryClient.invalidateQueries({ queryKey: restQueryKeys.library })
      await queryClient.invalidateQueries({ queryKey: ['rest', 'library', 'comic'] })
      await queryClient.invalidateQueries({ queryKey: ['rest', 'library', 'chapters'] })
    } finally {
      setAddingByResultId((current) => ({ ...current, [item.id]: false }))
      setAddProgressByResultId((current) => {
        const next = { ...current }
        delete next[item.id]
        return next
      })
    }
  }

  const hasResultBlocks = searchErrors.length > 0 || results.length > 0

  return (
    <div className="relative min-h-full bg-background pt-[var(--cu-safe-top,0px)]">
      <LoadingOverlay isLoading={isSearching} message={t('searchContent.search.searching')} />
      <div className="grid min-h-full grid-rows-[auto_minmax(0,1fr)]">
        <div className="sticky top-0 z-20 grid gap-px bg-background/72 px-3 pt-4 supports-backdrop-filter:backdrop-blur-xl sm:px-6 sm:pt-4">
          <div className="flex justify-end">
            <Button
              type="button"
              variant="destructive"
              size="icon-sm"
              className="h-8 w-8 rounded-full"
              onClick={() => closeSelf?.()}
              aria-label={t('searchContent.actions.close')}
            >
              <X className="size-4" />
            </Button>
          </div>
          <div className="grid h-12 grid-cols-[minmax(0,1fr)_3rem] overflow-hidden bg-background/90 shadow-sm supports-backdrop-filter:backdrop-blur-sm sm:h-14">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('searchContent.search.placeholder')}
              className="h-full rounded-none border-0 bg-transparent pl-4 text-base focus-visible:ring-0 sm:pl-5 sm:text-lg"
              autoFocus
            />
            <div className="flex items-center justify-center bg-background/80">
              <Search className="size-5 text-muted-foreground" />
            </div>
          </div>
          <div className="grid gap-px bg-transparent sm:h-11 sm:grid-cols-[auto_1fr]">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 w-full rounded-none bg-background/90 px-4 text-sm supports-backdrop-filter:backdrop-blur-sm sm:h-full sm:w-auto"
                >
                  {t('searchContent.plugins.title')} ({selectedPluginIds.length})
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72">
                {plugins.map((plugin) => (
                  <DropdownMenuCheckboxItem
                    key={plugin.id}
                    checked={selectedPluginIds.includes(plugin.id)}
                    onCheckedChange={() => handleTogglePlugin(plugin.id)}
                  >
                    {plugin.name}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="bg-background/90 px-3 py-2 text-xs text-muted-foreground supports-backdrop-filter:backdrop-blur-sm">
              {targetComicId && targetComicQuery.data?.title
                ? t('searchContent.plugins.linkingSubtitle', { title: targetComicQuery.data.title })
                : t('searchContent.plugins.subtitle')}
            </div>
          </div>
        </div>
        <div className="min-h-0 bg-background px-3 pb-3 pt-1 sm:px-6 sm:pb-4">
          <div
            className={`mx-auto flex w-full max-w-5xl flex-col bg-background ${
              hasResultBlocks ? 'gap-3 sm:gap-px' : 'min-h-full justify-center gap-3'
            }`}
          >
            {searchErrors.length > 0 && (
              <div className="bg-destructive/10 p-3 text-xs text-destructive">
                {searchErrors.map((error) => (
                  <p key={`${error.pluginId}:${error.endpoint}`}>
                    {error.pluginName}: {error.message}
                  </p>
                ))}
              </div>
            )}
            {results.map((item) => {
              const sourceKey = `${item.pluginTag}:${item.siteId}`
              const alreadyAdded = targetComicId
                ? targetComicSourceKeySet.has(sourceKey)
                : existingWorkSourceKeySet.has(sourceKey)
              return (
                <SearchResultCard
                  key={item.id}
                  item={item}
                  isExpanded={expandedResultId === item.id}
                  onToggle={() => void handleToggleResult(item)}
                  details={detailsByResultId[item.id]}
                  isLoadingDetails={Boolean(loadingDetailsByResultId[item.id])}
                  onAdd={(current) => void handleAddComic(current)}
                  isAdding={Boolean(addingByResultId[item.id])}
                  addProgress={addProgressByResultId[item.id]?.value}
                  addProgressMessage={addProgressByResultId[item.id]?.message}
                  alreadyAdded={alreadyAdded}
                  addLabel={t(targetComicId ? 'searchContent.actions.linkToCurrent' : 'searchContent.actions.add')}
                  addingLabel={t(targetComicId ? 'searchContent.actions.linking' : 'searchContent.actions.adding')}
                  addedLabel={t(targetComicId ? 'searchContent.actions.linked' : 'searchContent.actions.added')}
                  chaptersLabel={t('searchContent.labels.chapters')}
                />
              )
            })}
            {!isSearching && results.length === 0 && (
              <div className="bg-background p-4 text-sm text-muted-foreground">{t('searchContent.empty')}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
