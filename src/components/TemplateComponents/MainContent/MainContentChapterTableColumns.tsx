import type { Dispatch, SetStateAction } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { BookOpenCheck, CheckSquare2, ChevronUp, Loader2, Square, Undo2, WifiOff } from 'lucide-react'
import { Badge } from 'components/ui/badge'
import { Button } from 'components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from 'components/ui/tooltip'
import type { ChapterRowModel } from './MainContentChapterTableModel'

interface BuildChapterColumnsParams {
  selectionColumnVisible: boolean
  selectedIds: Set<string>
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  updateReadState: (chapterIds: string[], read: boolean) => void | Promise<void>
  t: (key: string, options?: Record<string, unknown>) => string
}

export const buildChapterColumns = ({
  selectionColumnVisible,
  selectedIds,
  setSelectedIds,
  updateReadState,
  t
}: BuildChapterColumnsParams): ColumnDef<ChapterRowModel>[] => {
  const columns: ColumnDef<ChapterRowModel>[] = []
  columns.push({
    id: 'select',
    header: ({ table }) => {
      const allRows = table.getPrePaginationRowModel().rows
      const allIds = allRows.map((row) => row.original.id)
      const allSelected = allIds.length > 0 && allIds.every((id) => selectedIds.has(id))

      return (
        <div
          className={`flex items-center justify-center overflow-hidden transition-all duration-200 ${
            selectionColumnVisible
              ? 'translate-x-0 opacity-100'
              : '-translate-x-2 opacity-0 pointer-events-none'
          }`}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="h-8 w-8 hover:bg-accent/70"
                onClick={() =>
                  setSelectedIds(
                    allSelected ? new Set() : new Set(allRows.map((row) => row.original.id))
                  )
                }
                aria-label={
                  allSelected
                    ? t('mainContent.chapterTable.actions.unselectAllChapters')
                    : t('mainContent.chapterTable.actions.selectAllChapters')
                }
              >
                {allSelected ? <CheckSquare2 className="size-4" /> : <Square className="size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {allSelected
                ? t('mainContent.chapterTable.actions.unselectAll')
                : t('mainContent.chapterTable.actions.selectAll')}
            </TooltipContent>
          </Tooltip>
        </div>
      )
    },
    cell: ({ row }) => {
      const selected = selectedIds.has(row.original.id)

      return (
        <div
          className={`flex items-center justify-center overflow-hidden transition-all duration-200 ${
            selectionColumnVisible
              ? 'translate-x-0 opacity-100'
              : '-translate-x-2 opacity-0 pointer-events-none'
          }`}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="h-8 w-8 hover:bg-accent/70"
                onClick={() =>
                  setSelectedIds((current) => {
                    const next = new Set(current)
                    if (next.has(row.original.id)) next.delete(row.original.id)
                    else next.add(row.original.id)
                    return next
                  })
                }
                aria-label={
                  selected
                    ? t('mainContent.chapterTable.actions.unselectChapter')
                    : t('mainContent.chapterTable.actions.selectChapter')
                }
              >
                {selected ? <CheckSquare2 className="size-4" /> : <Square className="size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {selected
                ? t('mainContent.chapterTable.actions.unselectChapter')
                : t('mainContent.chapterTable.actions.selectChapter')}
            </TooltipContent>
          </Tooltip>
        </div>
      )
    },
    enableSorting: false,
    size: selectionColumnVisible ? 44 : 0
  })

  columns.push(
    {
      accessorKey: 'chapterNumber',
      header: ({ column }) => {
        const sort = column.getIsSorted()
        return (
          <Button
            type="button"
            variant="ghost"
            className="h-8 w-full justify-center overflow-hidden rounded-none px-1 text-[11px] font-normal hover:bg-accent/70"
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
            aria-label={t('mainContent.chapterTable.headers.chapter')}
          >
            {t('mainContent.chapterTable.headers.chapter')}
            <ChevronUp
              className={`ml-1 size-2.5 transition-transform ${
                sort === 'desc' ? 'rotate-180' : ''
              } ${sort ? 'opacity-100' : 'opacity-45'}`}
            />
          </Button>
        )
      },
      cell: ({ row }) => <div className="px-1 text-center text-sm">{row.original.chapterNumber}</div>,
      sortingFn: (rowA, rowB) => {
        const a = rowA.original.numberSortValue
        const b = rowB.original.numberSortValue
        if (a !== null && b !== null && a !== b) return a - b
        if (a !== null && b === null) return -1
        if (a === null && b !== null) return 1
        return rowA.original.chapterNumber.localeCompare(rowB.original.chapterNumber, undefined, {
          numeric: true,
          sensitivity: 'base'
        })
      },
      size: 72
    },
    {
      accessorKey: 'chapterName',
      header: () => (
        <div className="px-2 text-xs font-normal">{t('mainContent.chapterTable.headers.name')}</div>
      ),
      cell: ({ row }) => (
        <div className="flex items-center justify-between gap-3 px-2">
          <div className="min-w-0 flex-1 truncate">{row.original.chapterName}</div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
            {row.original.chapterLanguages.map((language) => (
              <Badge key={`${row.original.id}:${language}`} variant="outline" className="px-1.5 py-0 text-[10px]">
                {language}
              </Badge>
            ))}
            {row.original.isOfflineDownloading ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[10px]">
                    <Loader2 className="size-3 animate-spin" />
                    {t('mainContent.chapterTable.labels.offlineDownloading')}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>{t('mainContent.chapterTable.labels.offlineDownloading')}</TooltipContent>
              </Tooltip>
            ) : null}
            {row.original.isOffline ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[10px]">
                    <WifiOff className="size-3" />
                    {t('mainContent.chapterTable.labels.offline')}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>{t('mainContent.chapterTable.labels.offline')}</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </div>
      ),
      enableSorting: false
    },
    {
      accessorKey: 'progress',
      header: () => <div className="sr-only">{t('mainContent.chapterTable.headers.progress')}</div>,
      cell: ({ row }) => <div className="px-1 text-center text-sm">{row.original.progress}%</div>,
      enableSorting: false,
      size: 56
    },
    {
      id: 'read',
      header: () => (
        <div className="px-2 text-xs text-muted-foreground">
          {t('mainContent.chapterTable.headers.read')}
        </div>
      ),
      cell: ({ row }) => (
        <div className="flex items-center justify-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="h-8 w-8 hover:bg-accent/70"
                onClick={() => void updateReadState([row.original.id], !row.original.isRead)}
                aria-label={
                  row.original.isRead
                    ? t('mainContent.chapterTable.actions.markUnread')
                    : t('mainContent.chapterTable.actions.markRead')
                }
              >
                {row.original.isRead ? <Undo2 className="size-4" /> : <BookOpenCheck className="size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {row.original.isRead
                ? t('mainContent.chapterTable.actions.markUnread')
                : t('mainContent.chapterTable.actions.markRead')}
            </TooltipContent>
          </Tooltip>
        </div>
      ),
      enableSorting: false,
      size: 52
    }
  )

  return columns
}
