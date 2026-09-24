export interface PluginDeepLinkPayload {
  endpoint: string
  metadataEndpoint?: string
  name?: string
  tag?: string
}

export interface PluginSourceMetadata {
  id: string
  name: string
  languageCodes?: string[]
  isDefault?: boolean
}

export interface PluginFeatureFlags {
  onDemandPageList?: boolean
}

export interface PluginMetadataResponse {
  name?: string
  tag?: string
  version?: string
  contentTypes?: string[]
  languageCodes?: string[]
  capabilities?: string[] | { metadata?: boolean; content?: boolean }
  features?: PluginFeatureFlags
  sources?: PluginSourceMetadata[]
}

export interface ComicImportPayload {
  comic: Record<string, unknown>
  chapters: Array<Record<string, unknown>>
}

export interface ComicImportResult {
  comicId: string
  comicName: string
  chaptersImported: number
  chaptersSkipped: number
}

export type DeepLinkProcessResult =
  | {
      kind: 'plugin'
      name: string
      endpoint: string
    }
  | {
      kind: 'comic'
      result: ComicImportResult
    }
