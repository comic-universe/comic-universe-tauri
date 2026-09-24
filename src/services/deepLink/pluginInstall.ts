import { dbFind, dbUpsert } from 'services'
import type { PluginDeepLinkPayload, PluginMetadataResponse } from './types'
import { normalizeBaseUrl, normalizePluginTag, SUPPORTED_DEEP_LINK_PROTOCOLS } from './utils'
import { normalizePluginFeatures } from 'services'

const buildPluginId = (tag: string | undefined, endpoint: string): string => {
  if (tag) return `plugin:${tag}`

  const normalizedEndpoint = endpoint
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120)

  return `plugin:${normalizedEndpoint || 'remote'}`
}

export const parsePluginInstallDeepLink = (raw: string): PluginDeepLinkPayload | null => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }

  if (!SUPPORTED_DEEP_LINK_PROTOCOLS.has(url.protocol)) return null
  if (url.hostname.toLowerCase() !== 'plugin') return null
  if (url.pathname.replace(/^\/+/, '').toLowerCase() !== 'install') return null

  const endpointParam = url.searchParams.get('url')?.trim()
  if (!endpointParam) return null

  const endpoint = normalizeBaseUrl(endpointParam)
  const metadataEndpoint = url.searchParams.get('metadataUrl')?.trim() || undefined

  return {
    endpoint,
    metadataEndpoint: metadataEndpoint ? normalizeBaseUrl(metadataEndpoint) : undefined,
    name: url.searchParams.get('name')?.trim() || undefined,
    tag: normalizePluginTag(url.searchParams.get('tag') || undefined)
  }
}

const fetchPluginMetadata = async (
  endpoint: string,
  metadataEndpoint?: string
): Promise<PluginMetadataResponse | null> => {
  const target = metadataEndpoint || `${endpoint}/metadata`
  try {
    const response = await fetch(target, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    })
    if (!response.ok) return null
    const data = (await response.json()) as PluginMetadataResponse
    return data
  } catch {
    return null
  }
}

const normalizeCapabilities = (
  input: PluginMetadataResponse['capabilities'] | undefined
): Array<'metadata' | 'content'> => {
  if (Array.isArray(input)) {
    const allowed = input.filter((entry): entry is 'metadata' | 'content' =>
      entry === 'metadata' || entry === 'content'
    )
    if (allowed.length > 0) return Array.from(new Set(allowed))
  }

  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const metadata = input.metadata !== false
    const content = input.content !== false
    return [
      ...(metadata ? (['metadata'] as const) : []),
      ...(content ? (['content'] as const) : [])
    ]
  }

  return ['metadata', 'content']
}

export const installPluginFromDeepLink = async (
  payload: PluginDeepLinkPayload
): Promise<{ name: string; endpoint: string }> => {
  const endpoint = normalizeBaseUrl(payload.endpoint)
  const metadataEndpoint = payload.metadataEndpoint || `${endpoint}/metadata`
  const metadata = await fetchPluginMetadata(endpoint, metadataEndpoint)

  const tag = normalizePluginTag(metadata?.tag || payload.tag || undefined)
  const name =
    metadata?.name?.trim() ||
    payload.name?.trim() ||
    tag ||
    endpoint.replace(/^https?:\/\//, '')

  const existingByEndpoint = await dbFind<Record<string, unknown>>('plugins', 'endpoint', endpoint, 1)
  const existingByLegacyUrl =
    existingByEndpoint.length > 0 ? [] : await dbFind<Record<string, unknown>>('plugins', 'url', endpoint, 1)
  const pluginId = existingByEndpoint[0]?.id || existingByLegacyUrl[0]?.id || buildPluginId(tag, endpoint)

  await dbUpsert(
    'plugins',
    {
      name,
      tag: tag || null,
      endpoint,
      metadataEndpoint,
      enabled: true,
      version: metadata?.version || null,
      contentTypes: metadata?.contentTypes || ['comic'],
      languageCodes: metadata?.languageCodes || [],
      capabilities: normalizeCapabilities(metadata?.capabilities),
      features: normalizePluginFeatures(metadata?.features),
      sources: metadata?.sources || [],
      installedFrom: 'deep-link',
      installedAt: new Date().toISOString()
    },
    pluginId
  )

  return { name, endpoint }
}
