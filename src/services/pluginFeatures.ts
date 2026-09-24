import type { PluginFeatureFlags } from './deepLink/types'

export const normalizePluginFeatures = (input: unknown): PluginFeatureFlags => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {}
  }

  const record = input as Record<string, unknown>
  const onDemandPageList = record.onDemandPageList

  return {
    onDemandPageList: typeof onDemandPageList === 'boolean' ? onDemandPageList : undefined
  }
}

export const supportsOnDemandPageList = (input: unknown): boolean | undefined =>
  normalizePluginFeatures(input).onDemandPageList
