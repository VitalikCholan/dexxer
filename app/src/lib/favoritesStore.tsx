// app/src/lib/favoritesStore.tsx
//
// Favourites context backed by AsyncStorage (`dexxer.favorites`). A read
// failure or a malformed value is never written back: toggles then stay in
// memory only (same rule as the History archive).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { favoritesWritable, parseFavorites, toggleFavorite } from './favorites'

const KEY = 'dexxer.favorites'

export interface Favorites {
  list: string[]
  isFavorite: (symbol: string) => boolean
  toggle: (symbol: string) => void
}

const FavoritesContext = createContext<Favorites>({ list: [], isFavorite: () => false, toggle: () => {} })

export function FavoritesProvider({ children }: PropsWithChildren) {
  const [list, setList] = useState<string[]>([])
  const [writable, setWritable] = useState(false)

  useEffect(() => {
    let cancelled = false
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (cancelled) return
        setList(parseFavorites(raw))
        setWritable(favoritesWritable(raw))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = useCallback(
    (symbol: string) => {
      const next = toggleFavorite(list, symbol)
      setList(next)
      if (writable) AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {})
    },
    [list, writable],
  )

  const value = useMemo(() => ({ list, isFavorite: (s: string) => list.includes(s), toggle }), [list, toggle])
  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>
}

export function useFavorites(): Favorites {
  return useContext(FavoritesContext)
}
