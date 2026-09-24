import { Dispatch, MouseEvent, SetStateAction, UIEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable
} from '@tanstack/react-table'
import { useTranslation } from 'react-i18next'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from 'components/ui/table'
import { dbDelete, dbFind, dbUpsert, restQueryKeys, type DbRecord, type ResolvedChapterRecord } from 'services'
import { cn } from 'utils'
import { MainContentChapterTableBulkActions } from './MainContentChapterTableBulkActions'
import { buildChapterColumns } from './MainContentChapterTableColumns'
import { type ChapterRowModel, mapChapterToRow } from './MainContentChapterTableModel'

interface MainContentChapterTableProps {
  entityId: string
  chapters: Array<ResolvedChapterRecord>
  progressByChapterId: Map<string, number>
  pendingOfflineChapterIds: Set<string>
  selectedIds: Set<string>
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  isSelectionMode: boolean
  onExitSelectionMode: () => void
  onOpenChapter: (chapterId: string) => void
  onMakeSelectedOffline: (chapterIds: string[]) => void | Promise<void>
}

const INITIAL_VISIBLE_ROWS = 80
const LOAD_MORE_STEP = 60
const SCROLL_THRESHOLD_PX = 240
type ReadProgressRecordData = {
  chapterId?: string
  comicId?: string
  page?: number
  totalPages?: number
  [key: string]: unknown
}

export const MainContentChapterTable = ({
  entityId,
  chapters,
  progressByChapterId,
  pendingOfflineChapterIds,
  selectedIds,
  setSelectedIds,
  isSelectionMode,
  onExitSelectionMode,
  onOpenChapter,
  onMakeSelectedOffline
}: MainContentChapterTableProps) => {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [isUpdatingReadState, setIsUpdatingReadState] = useState(false)
  const [sorting, setSorting] = useState<SortingState>([{ id: 'chapterNumber', desc: false }])
  const [visibleRowCount, setVisibleRowCount] = useState(INITIAL_VISIBLE_ROWS)
  const [isMobileViewport, setIsMobileViewport] = useState(false)

  const rows = useMemo<ChapterRowModel[]>(
    () => chapters.map((chapter) => mapChapterToRow(chapter, progressByChapterId, pendingOfflineChapterIds)),
    [chapters, progressByChapterId, pendingOfflineChapterIds]
  )

  const selectedIdList = useMemo(() => Array.from(selectedIds), [selectedIds])
  const hasSelection = selectedIds.size > 0
  const showSelectionColumn = isSelectionMode || hasSelection

  const updateReadState = useCallback(async (chapterIds: string[], read: boolean) => {
    if (!chapterIds.length) return
    setIsUpdatingReadState(true)
    const readProgressQueryKey = restQueryKeys.dbFind('read_progress', 'comicId', entityId, 5000)
    const previousReadProgress =
      queryClient.getQueryData<Array<DbRecord<ReadProgressRecordData>>>(readProgressQueryKey) ?? []
    try {
      if (read) {
        const persistedRecords = await Promise.all(
          chapterIds.map((chapterId) =>
            dbUpsert(
              'read_progress',
              {
                chapterId,
                comicId: entityId,
                page: 100,
                totalPages: 100
              },
              chapterId
            )
          )
        )

        queryClient.setQueryData<Array<DbRecord<ReadProgressRecordData>>>(readProgressQueryKey, (current) => {
          const next = new Map((current ?? []).map((record) => [record.id, record]))
          for (const record of persistedRecords) {
            next.set(record.id, record as DbRecord<ReadProgressRecordData>)
          }
          return [...next.values()]
        })
      } else {
        const recordsToDelete = await Promise.all(
          chapterIds.map(async (chapterId) => {
            const existing = await dbFind('read_progress', 'chapterId', chapterId, 1)
            const recordId = existing[0]?.id
            if (recordId) {
              await dbDelete('read_progress', recordId)
            }
            return recordId
          })
        )

        const deletedIds = new Set(recordsToDelete.filter((id): id is string => Boolean(id)))
        queryClient.setQueryData<Array<DbRecord<ReadProgressRecordData>>>(readProgressQueryKey, (current) =>
          (current ?? []).filter((record) => !deletedIds.has(record.id))
        )
      }

      await queryClient.invalidateQueries({
        queryKey: readProgressQueryKey
      })
      setSelectedIds((current) => {
        const next = new Set(current)
        chapterIds.forEach((id) => next.delete(id))
        return next
      })
    } catch (error) {
      queryClient.setQueryData(readProgressQueryKey, previousReadProgress)
      throw error
    } finally {
      setIsUpdatingReadState(false)
    }
  }, [entityId, queryClient, setSelectedIds])

  const runBulkReadStateUpdate = useCallback(async (read: boolean) => {
    if (!selectedIdList.length) return
    const targetIds = [...selectedIdList]
    setSelectedIds(new Set())
    onExitSelectionMode()
    await updateReadState(targetIds, read)
  }, [onExitSelectionMode, selectedIdList, setSelectedIds, updateReadState])

  const columns = useMemo(
    () =>
      buildChapterColumns({
        selectionColumnVisible: showSelectionColumn,
        selectedIds,
        setSelectedIds,
        updateReadState,
        t
      }),
    [showSelectionColumn, selectedIds, t, updateReadState]
  )

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  })

  const sortedRows = table.getRowModel().rows
  const renderedRows = useMemo(
    () => sortedRows.slice(0, Math.min(visibleRowCount, sortedRows.length)),
    [sortedRows, visibleRowCount]
  )
  const canLoadMore = renderedRows.length < sortedRows.length

  useEffect(() => {
    setVisibleRowCount(INITIAL_VISIBLE_ROWS)
  }, [entityId, sorting, rows.length])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 768px)')
    const applyMatch = () => setIsMobileViewport(media.matches)

    applyMatch()
    media.addEventListener('change', applyMatch)

    return () => {
      media.removeEventListener('change', applyMatch)
    }
  }, [])

  const loadMoreRows = useCallback(() => {
    setVisibleRowCount((current) => Math.min(current + LOAD_MORE_STEP, sortedRows.length))
  }, [sortedRows.length])

  const onContainerScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (!canLoadMore) return
      const target = event.currentTarget
      if (target.scrollTop + target.clientHeight >= target.scrollHeight - SCROLL_THRESHOLD_PX) {
        loadMoreRows()
      }
    },
    [canLoadMore, loadMoreRows]
  )

  const handleRowClick = useCallback(
    (event: MouseEvent<HTMLTableRowElement>, chapterId: string) => {
      const target = event.target as HTMLElement
      if (target.closest('button, a, input, label, [role="button"], [role="checkbox"]')) return

      if (isSelectionMode) {
        setSelectedIds((current) => {
          const next = new Set(current)
          if (next.has(chapterId)) next.delete(chapterId)
          else next.add(chapterId)
          return next
        })
        return
      }

      if (!isMobileViewport) return
      onOpenChapter(chapterId)
    },
    [isMobileViewport, isSelectionMode, onOpenChapter, setSelectedIds]
  )

  return (
    <div className="min-h-0 overflow-auto" onScroll={onContainerScroll}>
      <div
        className={cn(
          'sticky top-0 z-20 overflow-hidden transition-all duration-250 ease-out',
          hasSelection
            ? 'max-h-20 translate-y-0 opacity-100'
            : 'max-h-0 -translate-y-1 opacity-0 pointer-events-none'
        )}
      >
        <MainContentChapterTableBulkActions
          selectedCount={selectedIds.size}
          isUpdating={isUpdatingReadState}
          clearSelection={() => {
            setSelectedIds(new Set())
            onExitSelectionMode()
          }}
          makeSelectedOffline={() => void onMakeSelectedOffline(selectedIdList)}
          markSelectedRead={() => void runBulkReadStateUpdate(true)}
          markSelectedUnread={() => void runBulkReadStateUpdate(false)}
          t={t}
        />
      </div>

      <Table className="table-fixed border-separate border-spacing-x-[1px] border-spacing-y-0 bg-transparent">
        <TableHeader className="[&_tr]:border-0">
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id} className="border-0 bg-transparent hover:bg-transparent">
              {headerGroup.headers.map((header) => (
                <TableHead
                  key={header.id}
                  style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}
                  className={cn(
                    'h-10 border-0 border-b border-border/40 bg-background px-1 transition-all duration-200',
                    header.column.id === 'select' && !showSelectionColumn ? 'w-0 px-0' : '',
                    header.column.id === 'progress' ? 'text-right' : ''
                  )}
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {renderedRows.length ? (
            renderedRows.map((row) => {
              const isSelected = selectedIds.has(row.original.id)
              return (
                <TableRow
                  key={row.id}
                  data-state={isSelected ? 'selected' : undefined}
                  className="group border-0 bg-transparent hover:bg-transparent data-[state=selected]:bg-transparent"
                  onClick={(event) => handleRowClick(event, row.original.id)}
                  onDoubleClick={() => {
                    if (isSelectionMode) return
                    onOpenChapter(row.original.id)
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    if (isSelectionMode) {
                      setSelectedIds((current) => {
                        const next = new Set(current)
                        if (next.has(row.original.id)) next.delete(row.original.id)
                        else next.add(row.original.id)
                        return next
                      })
                      return
                    }
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      onOpenChapter(row.original.id)
                    }
                  }}
                  tabIndex={0}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cn(
                        'h-11 border-0 bg-background px-1 transition-all duration-200 group-hover:bg-accent/40',
                        cell.column.id === 'select' && !showSelectionColumn ? 'w-0 px-0' : ''
                      )}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              )
            })
          ) : (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="h-20 border-0 bg-background text-center text-muted-foreground"
              >
                {t('mainContent.chapterTable.empty')}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {canLoadMore ? (
        <div className="mt-px bg-background px-2 py-1.5 text-center text-xs text-muted-foreground">
          {renderedRows.length}/{sortedRows.length}
        </div>
      ) : null}
    </div>
  )
}
