import { FC } from 'react'
import { Button } from 'components/ui/button'

interface MainContentChapterTableBulkActionsProps {
  selectedCount: number
  isUpdating: boolean
  clearSelection: () => void
  markSelectedRead: () => void
  markSelectedUnread: () => void
  makeSelectedOffline: () => void
  t: (key: string, options?: Record<string, unknown>) => string
}

export const MainContentChapterTableBulkActions: FC<MainContentChapterTableBulkActionsProps> = ({
  selectedCount,
  isUpdating,
  clearSelection,
  markSelectedRead,
  markSelectedUnread,
  makeSelectedOffline,
  t
}) => {
  return (
    <div className="animate-in fade-in-0 slide-in-from-top-1 sticky top-0 z-20 flex items-center gap-2 border-b border-border/40 bg-background p-2 duration-200">
      <div className="text-xs text-muted-foreground">
        {t('mainContent.chapterTable.bulk.selectedCount', { count: selectedCount })}
      </div>
      <Button type="button" size="sm" variant="ghost" className="h-8 px-2" onClick={clearSelection} disabled={isUpdating}>
        {t('mainContent.chapterTable.bulk.clear')}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-8 px-2"
        onClick={makeSelectedOffline}
        disabled={false}
      >
        {t('mainContent.chapterTable.bulk.makeOffline')}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-8 px-2"
        onClick={markSelectedRead}
        disabled={isUpdating}
      >
        {t('mainContent.chapterTable.bulk.markRead')}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-8 px-2"
        onClick={markSelectedUnread}
        disabled={isUpdating}
      >
        {t('mainContent.chapterTable.bulk.markUnread')}
      </Button>
    </div>
  )
}
