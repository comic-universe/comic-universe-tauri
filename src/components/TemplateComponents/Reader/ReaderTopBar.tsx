import { FC, MouseEvent } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ArrowRight, BookOpen, BookOpenCheck, Columns2, Languages, Rows3, X } from 'lucide-react'
import { IconTooltipButton } from 'components'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger
} from 'components/ui/dropdown-menu'
import { useTranslation } from 'react-i18next'

interface ReaderTopBarProps {
  comicName: string
  chapterName: string
  currentChapterAvailableLanguages: string[]
  selectedChapterLanguage: string
  autoLanguageMode: string
  readingMode: 'horizontal' | 'vertical'
  readingDirection: 'ltr' | 'rtl'
  doublePageSpread: boolean
  disableDoublePageSpread?: boolean
  onSelectChapterLanguage: (language: string) => void
  onSetReadingMode: (vertical: boolean) => void
  onSetReadingDirection: (rtl: boolean) => void
  onSetDoublePageSpread: (enabled: boolean) => void
  onClose: () => void
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

export const ReaderTopBar: FC<ReaderTopBarProps> = ({
  comicName,
  chapterName,
  currentChapterAvailableLanguages,
  selectedChapterLanguage,
  autoLanguageMode,
  readingMode,
  readingDirection,
  doublePageSpread,
  disableDoublePageSpread = false,
  onSelectChapterLanguage,
  onSetReadingMode,
  onSetReadingDirection,
  onSetDoublePageSpread,
  onClose
}) => {
  const { t, i18n } = useTranslation()
  const showLanguagePicker = currentChapterAvailableLanguages.length > 1
  const selectedLanguageLabel = selectedChapterLanguage === autoLanguageMode
    ? t('mainContent.nav.languages.auto')
    : languageLabel(selectedChapterLanguage, i18n.resolvedLanguage || i18n.language || 'en')

  const handleWindowDrag = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return

    const target = event.target as HTMLElement
    if (target.closest('[data-no-window-drag]')) return

    void getCurrentWindow().startDragging()
  }

  return (
    <div
      onMouseDown={handleWindowDrag}
      className="relative z-20 h-[calc(3rem+var(--cu-safe-top,0px))] bg-background backdrop-blur-sm"
    >
      <div data-tauri-drag-region className="absolute inset-0" />
      <div data-tauri-drag-region className="absolute inset-x-0 bottom-0 flex h-12 items-center gap-2 px-3 sm:justify-end" />

      <div className="absolute inset-x-0 bottom-0 flex h-12 items-center gap-2 px-3 sm:justify-end">
        <div className="min-w-0 flex-1 pr-1 sm:hidden">
          <p className="truncate text-left text-sm">{comicName}</p>
          <p className="truncate text-left text-xs text-foreground/70">{chapterName}</p>
        </div>

        <div className="z-20 flex shrink-0 items-center gap-2">
          {showLanguagePicker ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <div data-no-window-drag>
                  <IconTooltipButton
                    label={`${t('mainContent.nav.languages.select')}: ${selectedLanguageLabel}`}
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
                {currentChapterAvailableLanguages.map((language) => (
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
            label={t('reader.verticalReading')}
            onClick={() => onSetReadingMode(readingMode !== 'vertical')}
            data-no-window-drag
            icon={readingMode === 'vertical' ? <Rows3 className="size-4" /> : <Columns2 className="size-4" />}
          />

          <IconTooltipButton
            label={t('reader.rightToLeft')}
            onClick={() => onSetReadingDirection(readingDirection !== 'rtl')}
            data-no-window-drag
            icon={
              <ArrowRight
                className={`size-4 transition-transform ${readingDirection === 'rtl' ? 'rotate-180' : ''}`}
              />
            }
          />

          <IconTooltipButton
            label={t('reader.doublePageSpread')}
            onClick={() => onSetDoublePageSpread(!doublePageSpread)}
            disabled={readingMode !== 'horizontal' || disableDoublePageSpread}
            data-no-window-drag
            icon={doublePageSpread ? <BookOpenCheck className="size-4" /> : <BookOpen className="size-4" />}
          />

          <IconTooltipButton
            label={t('reader.close')}
            onClick={onClose}
            data-no-window-drag
            className="h-8 w-8 rounded-full transition-colors hover:bg-accent/70"
            icon={<X className="size-4" />}
          />
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-12 items-center justify-center px-20 sm:flex">
        <div className="min-w-0 text-center">
          <p className="truncate text-sm">{comicName}</p>
          <p className="truncate text-xs text-foreground/70">{chapterName}</p>
        </div>
      </div>
    </div>
  )
}
