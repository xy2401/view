export interface LocationRef {
  name: string
  url: string
}

export interface Place extends LocationRef {
  kind: 'autoindex' | 'webdav' | 'local' | 'hosted'
}

export interface Entry extends LocationRef {
  directory: boolean
  thumbnailUrl?: string
  size?: number
  modified?: string
}

export interface OpenTarget {
  folder: LocationRef
  file: Entry
}

export interface DesktopState {
  favorites: LocationRef[]
  shares: LocationRef[]
  server: { url: string; key: string } | null
}

interface DesktopBridge {
  state(): Promise<DesktopState>
  openFolder(): Promise<LocationRef | null>
  openFile(): Promise<OpenTarget | null>
  takeOpenTarget(): Promise<OpenTarget | null>
  onOpenTarget(notify: () => void): () => void
  list(url: string): Promise<Entry[]>
  setFavorite(url: string, value: boolean): Promise<void>
  setShared(url: string, value: boolean): Promise<void>
  startServer(): Promise<void>
  stopServer(): Promise<void>
  pairingUrl(): Promise<string>
}

declare global {
  interface Window {
    viewDesktop?: DesktopBridge
  }
}
