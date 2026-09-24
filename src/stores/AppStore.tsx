import { create } from 'zustand'

export interface AccountSession {
  token: string
  expiresAt: string
  deviceName: string
  email: string
  websiteUserId: string
  username?: string | null
  displayName?: string | null
}

interface AppStore {
  theme: string
  setTheme: (newTheme: string) => void
  wallpaper: string
  setWallpaper: (newWallpaper: string) => void
  account: AccountSession | null
  accountHydrated: boolean
  hydrateAccount: (account: AccountSession | null) => void
  setAccount: (account: AccountSession | null) => void
  logout: () => void
  isMobileListOpen: boolean
  setMobileListOpen: (open: boolean) => void
  selectedWorkId: string | null
  setSelectedWorkId: (workId: string | null) => void
}

export const useAppStore = create<AppStore>((set) => ({
  theme: 'dark',
  setTheme: (newTheme: string) => set({ theme: newTheme }),
  wallpaper: 'starrySky',
  setWallpaper: (newWallpaper: string) => set({ wallpaper: newWallpaper }),
  account: null,
  accountHydrated: false,
  hydrateAccount: (account: AccountSession | null) => set({ account, accountHydrated: true }),
  setAccount: (account: AccountSession | null) => set({ account }),
  logout: () => set({ account: null }),
  isMobileListOpen: false,
  setMobileListOpen: (open: boolean) => set({ isMobileListOpen: open }),
  selectedWorkId: null,
  setSelectedWorkId: (selectedWorkId: string | null) => set({ selectedWorkId })
}))
