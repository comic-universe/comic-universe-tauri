import { FC, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { isTauri } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { processDeepLinkUrl } from 'services/deepLink'
import { accountSessionQueryKey, getApiBaseUrl, restQueryKeys, setApiBaseUrl } from 'services'

interface ApiEndpointPayload {
  host: string
  port: number
  baseUrl: string
}

const DEEP_LINK_EVENT = 'deep-link://urls'

export const ApiEndpointBridge: FC = () => {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let unlistenDeepLink: (() => void) | undefined
    let unlistenDeepLinkFallback: (() => void) | undefined
    let removeDevDeepLinkListener: (() => void) | undefined
    let cancelled = false
    const handledUrls = new Set<string>()

    const setup = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')

        unlisten = await listen<ApiEndpointPayload>('api://endpoint', (event) => {
          if (cancelled) return
          const nextBaseUrl = event.payload.baseUrl.trim()
          const currentBaseUrl = getApiBaseUrl().trim()
          if (!nextBaseUrl || nextBaseUrl === currentBaseUrl) {
            return
          }

          setApiBaseUrl(nextBaseUrl)
          void queryClient.invalidateQueries({ queryKey: restQueryKeys.health })
          void queryClient.invalidateQueries({ queryKey: accountSessionQueryKey })
          void queryClient.invalidateQueries({ queryKey: ['rest'] })
          console.info(
            `[comic-universe] REST API endpoint set to ${nextBaseUrl} (${event.payload.host}:${event.payload.port})`
          )
        })

        if (!isTauri()) return

        const processUrlList = async (urls: string[]) => {
          for (const raw of urls) {
            if (cancelled || handledUrls.has(raw)) continue
            handledUrls.add(raw)

            try {
              const result = await processDeepLinkUrl(raw)
              if (!result) continue

              if (result.kind === 'plugin') {
                await queryClient.invalidateQueries({ queryKey: ['rest', 'db', 'list', 'plugins'] })
                toast.success(t('deepLink.pluginAdded.title'), {
                  description: t('deepLink.pluginAdded.description', { name: result.name })
                })
                continue
              }

              await Promise.all([
                queryClient.invalidateQueries({ queryKey: restQueryKeys.comics }),
                queryClient.invalidateQueries({ queryKey: ['rest', 'chapters'] })
              ])

              const description =
                result.result.chaptersSkipped > 0
                  ? t('deepLink.comicAdded.descriptionWithSkipped', {
                      comicName: result.result.comicName,
                      chaptersImported: result.result.chaptersImported,
                      chaptersSkipped: result.result.chaptersSkipped
                    })
                  : t('deepLink.comicAdded.description', {
                      comicName: result.result.comicName,
                      chaptersImported: result.result.chaptersImported
                    })

              toast.success(t('deepLink.comicAdded.title'), {
                description
              })
            } catch (error) {
              const message =
                error instanceof Error && error.message.trim().length > 0
                  ? error.message
                  : t('deepLink.unknownImportError')
              console.error('[comic-universe] failed to process deep-link', error)
              toast.error(t('deepLink.importFailed'), { description: message })
            }
          }
        }

        if (import.meta.env.DEV) {
          const fromQuery = new URLSearchParams(window.location.search).get('deep_link')
          if (fromQuery) {
            void processUrlList([fromQuery])
          }

          ;(window as Window & { __CU_DEBUG_DEEPLINK?: (url: string) => void }).__CU_DEBUG_DEEPLINK =
            (url: string) => {
              if (!url || typeof url !== 'string') return
              void processUrlList([url])
            }

          const devDeepLinkListener = (event: Event) => {
            const detail = (event as CustomEvent<string>).detail
            if (detail && typeof detail === 'string') {
              void processUrlList([detail])
            }
          }
          window.addEventListener('comic-universe:deeplink', devDeepLinkListener)
          removeDevDeepLinkListener = () => {
            window.removeEventListener('comic-universe:deeplink', devDeepLinkListener)
          }
        }

        const deepLink = await import('@tauri-apps/plugin-deep-link')
        unlistenDeepLink = await deepLink.onOpenUrl((urls) => {
          void processUrlList(urls)
        })

        const current = await deepLink.getCurrent()
        if (current && current.length > 0) {
          void processUrlList(current)
        }

        unlistenDeepLinkFallback = await listen<string[]>(DEEP_LINK_EVENT, (event) => {
          void processUrlList(event.payload || [])
        })
      } catch {
        // Browser dev mode: event bridge may not be available.
      }
    }

    void setup()

    return () => {
      cancelled = true
      unlisten?.()
      unlistenDeepLink?.()
      unlistenDeepLinkFallback?.()
      removeDevDeepLinkListener?.()
    }
  }, [queryClient, t])

  return null
}
