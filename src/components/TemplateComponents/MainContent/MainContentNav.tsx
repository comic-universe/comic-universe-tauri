import { FC } from 'react'
import { Square, SquareCheck, ImagePlay, Languages, Link2, RefreshCw } from 'lucide-react'
import { IconTooltipButton } from 'components'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger
} from 'components/ui/dropdown-menu'
import { useTranslation } from 'react-i18next'

interface MainContentNavProps {
  totalProgress: number
  availableChapterLanguages: string[]
  selectedChapterLanguage: string | null
  autoLanguageMode: string
  onSelectChapterLanguage: (language: string) => void
  isSelectionMode: boolean
  onToggleSelectionMode: () => void
  onRead: () => void
  onLinkMetadata: () => void
  onRefreshChapters: () => void
  isRefreshingChapters?: boolean
  readDisabled?: boolean
}

const languageLabel = (value: string, locale: string): string => {
  const normalized = value.trim()
  if (!normalized) return '-'

  try {
    const displayNames = new Intl.DisplayNames([locale], { type: 'language' })
    const resolved = displayNames.of(normalized)
    if (resolved && resolved.trim()) {
      return `${resolved} (${normalized.toUpperCase()})`
    }
  } catch {
    // Ignore unsupported locales/codes and fall back to the raw code.
  }

  return normalized.toUpperCase()
}

export const MainContentNav: FC<MainContentNavProps> = ({
  totalProgress,
  availableChapterLanguages,
  selectedChapterLanguage,
  autoLanguageMode,
  onSelectChapterLanguage,
  isSelectionMode,
  onToggleSelectionMode,
  onRead,
  onLinkMetadata,
  onRefreshChapters,
  isRefreshingChapters = false,
  readDisabled
}) => {
  const { t, i18n } = useTranslation()
  const showLanguagePicker = availableChapterLanguages.length > 1
  const selectedLanguageLabel = selectedChapterLanguage === autoLanguageMode
    ? t('mainContent.nav.languages.auto')
    : selectedChapterLanguage
    ? languageLabel(selectedChapterLanguage, i18n.resolvedLanguage || i18n.language || 'en')
    : t('mainContent.nav.languages.none')

  return (
    <div className="flex h-12 w-full items-center justify-between gap-2 bg-background p-2">
      <div className="flex items-center justify-center">
        <IconTooltipButton
          label={
            isSelectionMode
              ? t('mainContent.chapterTable.mobile.doneSelection')
              : t('mainContent.chapterTable.mobile.selectChapters')
          }
          className="h-8 w-8 hover:bg-accent/70"
          onClick={onToggleSelectionMode}
          icon={isSelectionMode ? <SquareCheck className="size-4.5" /> : <Square className="size-4.5" />}
          iconClassName="size-5"
        />
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <div className="shrink-0 text-lg">{totalProgress}%</div>
      </div>
      <div className="flex items-center justify-center gap-2">
        {showLanguagePicker ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <div>
                <IconTooltipButton
                  label={`${t('mainContent.nav.languages.select')}: ${selectedLanguageLabel}`}
                  className="h-8 w-8 hover:bg-accent/70"
                  onClick={() => {}}
                  icon={<Languages className="size-4" />}
                />
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuCheckboxItem
                checked={selectedChapterLanguage === autoLanguageMode}
                onCheckedChange={() => onSelectChapterLanguage(autoLanguageMode)}
              >
                {t('mainContent.nav.languages.auto')}
              </DropdownMenuCheckboxItem>
              {availableChapterLanguages.map((language) => (
                <DropdownMenuCheckboxItem
                  key={language}
                  checked={selectedChapterLanguage === language}
                  onCheckedChange={() => onSelectChapterLanguage(language)}
                >
                  {languageLabel(language, i18n.resolvedLanguage || i18n.language || 'en')}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <IconTooltipButton
          label={t('mainContent.nav.actions.refreshChapters')}
          className="h-8 w-8 hover:bg-accent/70"
          onClick={onRefreshChapters}
          disabled={isRefreshingChapters}
          icon={<RefreshCw className={`size-4 ${isRefreshingChapters ? 'animate-spin' : ''}`} />}
        />
        <IconTooltipButton
          label={t('mainContent.nav.actions.linkMetadata')}
          className="h-8 w-8 hover:bg-accent/70"
          onClick={onLinkMetadata}
          icon={<Link2 className="size-4" />}
        />
        <IconTooltipButton
          label={t('mainContent.nav.actions.read')}
          className="h-8 w-8 hover:bg-accent/70"
          onClick={onRead}
          disabled={readDisabled}
          icon={<ImagePlay className="size-4" />}
        />
      </div>
    </div>
  )
}
