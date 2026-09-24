import { ComponentProps, FC, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { BgBox } from 'components'
import { Button } from 'components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from 'components/ui/sheet'
import { getComicCoverUrl, restQueryKeys, useDeleteLibraryComicMutation, useLibraryListQuery } from 'services'
import { cn } from 'utils'
import { useTranslation } from 'react-i18next'
import { LeftListItem } from './LeftListItem'

interface LeftListProps extends ComponentProps<'div'> {
  selectedWorkId?: string | null
  onSelectWork?: (workId: string | null) => void
}

export const LeftList: FC<LeftListProps> = ({
  className,
  selectedWorkId,
  onSelectWork,
  ...props
}) => {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const libraryQuery = useLibraryListQuery()
  const deleteLibraryComicMutation = useDeleteLibraryComicMutation()
  const [removingWorkId, setRemovingWorkId] = useState<string | null>(null)
  const [confirmDeleteWorkId, setConfirmDeleteWorkId] = useState<string | null>(null)
  const hasInitializedSelectionRef = useRef(false)
  const visibleWorks = useMemo(() => libraryQuery.data ?? [], [libraryQuery.data])

  useEffect(() => {
    if (selectedWorkId) {
      hasInitializedSelectionRef.current = true
    }
  }, [selectedWorkId])

  useEffect(() => {
    if (hasInitializedSelectionRef.current) return

    if (!selectedWorkId && visibleWorks.length) {
      hasInitializedSelectionRef.current = true
      onSelectWork?.(visibleWorks[0].comicId)
    }
  }, [selectedWorkId, visibleWorks, onSelectWork])

  const removeWork = async (workId: string) => {
    if (removingWorkId) return

    const nextSelectedWorkId =
      visibleWorks.find((work) => work.comicId !== workId)?.comicId ?? null
    setRemovingWorkId(workId)
    try {
      await deleteLibraryComicMutation.mutateAsync(workId)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: restQueryKeys.library }),
        queryClient.invalidateQueries({ queryKey: ['rest', 'library', 'comic'] }),
        queryClient.invalidateQueries({ queryKey: ['rest', 'library', 'chapters'] }),
        queryClient.invalidateQueries({ queryKey: ['rest', 'db', 'find', 'read_progress'] })
      ])
      await libraryQuery.refetch()

      if (selectedWorkId === workId) {
        hasInitializedSelectionRef.current = true
        onSelectWork?.(nextSelectedWorkId)
      }
    } catch (error) {
      await queryClient.invalidateQueries({ queryKey: restQueryKeys.library })
      throw error
    } finally {
      setRemovingWorkId(null)
      setConfirmDeleteWorkId((current) => (current === workId ? null : current))
    }
  }

  const confirmDeleteWork = (libraryQuery.data ?? []).find((work) => work.comicId === confirmDeleteWorkId) ?? null
  const confirmDeleteWorkName =
    confirmDeleteWork?.title ||
    confirmDeleteWorkId ||
    ''

  return (
    <BgBox className={cn('min-h-0 overflow-auto', className)} {...props}>
      <div className="divide-y divide-white/10">
        {visibleWorks.map((work) => {
          const workName = work.title || work.comicId
          const coverUrl = getComicCoverUrl(work.comicId)

          return (
            <LeftListItem
              key={work.comicId}
              title={workName}
              coverUrl={coverUrl}
              onClick={() => {
                hasInitializedSelectionRef.current = true
                onSelectWork?.(work.comicId)
              }}
              onRemove={() => setConfirmDeleteWorkId(work.comicId)}
              removing={removingWorkId === work.comicId}
              active={work.comicId === selectedWorkId}
            />
          )
        })}
        {!visibleWorks.length && (
          <div className="p-3 text-sm text-muted-foreground">{t('library.empty')}</div>
        )}
      </div>
      <Sheet
        open={Boolean(confirmDeleteWorkId)}
        onOpenChange={(open) => {
          if (!open && !removingWorkId) {
            setConfirmDeleteWorkId(null)
          }
        }}
      >
        <SheetContent side="bottom" showCloseButton={false} className="gap-0">
          <SheetHeader>
            <SheetTitle>{t('library.remove.confirmTitle')}</SheetTitle>
            <SheetDescription>
              {removingWorkId
                ? t('library.remove.removing')
                : t('library.remove.confirmDescription', { title: confirmDeleteWorkName })}
            </SheetDescription>
          </SheetHeader>
          <SheetFooter className="sm:flex-row">
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmDeleteWorkId(null)}
              disabled={Boolean(removingWorkId)}
            >
              {t('library.remove.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (!confirmDeleteWorkId) return
                void removeWork(confirmDeleteWorkId)
              }}
              disabled={Boolean(removingWorkId)}
            >
              {removingWorkId ? t('library.remove.removing') : t('library.remove.confirmAction')}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </BgBox>
  )
}
