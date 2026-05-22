/**
 * GIPHY GIF picker — modal that searches GIPHY and returns a selection
 * shaped like the rest of team_messages.attachments rows.
 *
 * Mirrors the web app's GifPickerPopover (src/app.jsx ~4814). Uses the
 * same client-side API key (GIPHY keys are designed to be embedded — see
 * the note in app.jsx). On select we hand back:
 *   { path: null, name, size: 0, type: 'image/gif', url, source: 'giphy', giphy_id }
 *
 * The consumer adds it to its pendingAttachments list and includes it in
 * the team_messages.attachments jsonb when sending. AttachmentView in
 * team-thread/[id].tsx already handles `path: null` items by reading
 * `attachment.url` directly.
 *
 * Presentation: pageSheet on iOS so it slides up as a card and has a
 * native swipe-down dismiss gesture. The status-bar collision the
 * earlier full-screen Modal caused (title overlapping the clock /
 * carrier indicator, Done button hidden under signal icons) is gone
 * with pageSheet because iOS positions the sheet below the bar.
 *
 * Pagination: GIPHY returns 24 per page; we fetch the next batch when
 * the user nears the end of the grid (onEndReached). pagination.total_count
 * from the response gates further fetches.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

const GIPHY_API_KEY = '0btoI3X8C1qh2m0JnpCHGSCxfcZ0Cet1'
const GIPHY_SEARCH_URL = 'https://api.giphy.com/v1/gifs/search'
const GIPHY_TRENDING_URL = 'https://api.giphy.com/v1/gifs/trending'
const PAGE_SIZE = 24

export type GiphyAttachment = {
  path: null
  name: string
  size: number
  type: 'image/gif'
  url: string
  source: 'giphy'
  giphy_id: string
}

type GiphyResult = {
  id: string
  slug?: string
  title?: string
  images?: {
    fixed_height?: { url?: string }
    fixed_height_small?: { url?: string }
    fixed_height_downsampled?: { url?: string }
    original?: { url?: string }
  }
}

export function GifPicker({
  visible,
  onClose,
  onSelect,
}: {
  visible: boolean
  onClose: () => void
  onSelect: (gif: GiphyAttachment) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<GiphyResult[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // Token to invalidate in-flight requests when the query changes.
  // Prevents an old "burrito" response from clobbering newer "pizza" results.
  const fetchTokenRef = useRef(0)

  // Reset when the modal opens
  useEffect(() => {
    if (!visible) return
    setQuery('')
    setErr(null)
    setResults([])
    setHasMore(true)
  }, [visible])

  // Build the GIPHY URL for a given query + offset
  const buildUrl = useCallback((q: string, offset: number) => {
    const trimmed = q.trim()
    const base = trimmed ? GIPHY_SEARCH_URL : GIPHY_TRENDING_URL
    const params = new URLSearchParams({
      api_key: GIPHY_API_KEY,
      limit: String(PAGE_SIZE),
      offset: String(offset),
      rating: 'pg-13',
    })
    if (trimmed) params.set('q', trimmed)
    return `${base}?${params.toString()}`
  }, [])

  // Initial / search-change fetch (debounced; trending on empty query)
  useEffect(() => {
    if (!visible) return
    const token = ++fetchTokenRef.current
    const timer = setTimeout(async () => {
      setLoading(true)
      setErr(null)
      try {
        const resp = await fetch(buildUrl(query, 0))
        if (!resp.ok) throw new Error(`GIPHY HTTP ${resp.status}`)
        const json = await resp.json()
        if (token !== fetchTokenRef.current) return
        const data = (json?.data ?? []) as GiphyResult[]
        const total = Number(json?.pagination?.total_count ?? 0)
        setResults(data)
        setHasMore(data.length >= PAGE_SIZE && data.length < total)
      } catch (e) {
        if (token === fetchTokenRef.current) {
          setErr(e instanceof Error ? e.message : 'Failed to load GIFs')
        }
      } finally {
        if (token === fetchTokenRef.current) setLoading(false)
      }
    }, query.trim() ? 250 : 0)
    return () => {
      clearTimeout(timer)
    }
  }, [query, visible, buildUrl])

  // Load the next page when the user scrolls to the bottom of the grid
  const loadMore = useCallback(async () => {
    if (loadingMore || loading || !hasMore) return
    const token = fetchTokenRef.current
    setLoadingMore(true)
    try {
      const resp = await fetch(buildUrl(query, results.length))
      if (!resp.ok) throw new Error(`GIPHY HTTP ${resp.status}`)
      const json = await resp.json()
      if (token !== fetchTokenRef.current) return
      const data = (json?.data ?? []) as GiphyResult[]
      const total = Number(json?.pagination?.total_count ?? 0)
      setResults((prev) => {
        const next = [...prev, ...data]
        setHasMore(data.length >= PAGE_SIZE && next.length < total)
        return next
      })
    } catch (e) {
      if (token === fetchTokenRef.current) {
        // Non-fatal — keep what we have, just stop trying
        setHasMore(false)
      }
    } finally {
      if (token === fetchTokenRef.current) setLoadingMore(false)
    }
  }, [buildUrl, hasMore, loading, loadingMore, query, results.length])

  const handleSelect = (g: GiphyResult) => {
    const full = g.images?.fixed_height?.url ?? g.images?.original?.url ?? ''
    if (!full) return
    onSelect({
      path: null,
      name: (g.slug || g.id) + '.gif',
      size: 0,
      type: 'image/gif',
      url: full,
      source: 'giphy',
      giphy_id: g.id,
    })
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      // iOS-only — slides up as a sheet with native swipe-to-dismiss.
      // On Android it falls back to a full-screen modal (acceptable;
      // we're iOS-first per the user).
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={onClose}
            style={styles.cancelBtn}
            hitSlop={12}
          >
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.title}>🎬 GIPHY</Text>
          {/* Spacer so the title sits centered between Cancel and the right edge */}
          <View style={styles.headerSpacer} />
        </View>

        <View style={styles.searchBar}>
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search GIFs… (or browse trending)"
            placeholderTextColor="#78716c"
            autoFocus
            autoCorrect={false}
            returnKeyType="search"
          />
        </View>

        {err && (
          <View style={styles.errBox}>
            <Text style={styles.errText}>⚠ {err}</Text>
          </View>
        )}

        {loading && results.length === 0 ? (
          <View style={styles.loading}>
            <ActivityIndicator color="#d97706" />
          </View>
        ) : results.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              No GIFs found{query.trim() ? ` for "${query.trim()}"` : ''}.
            </Text>
          </View>
        ) : (
          <FlatList
            data={results}
            keyExtractor={(g, i) => `${g.id}-${i}`}
            numColumns={3}
            contentContainerStyle={styles.grid}
            keyboardShouldPersistTaps="handled"
            onEndReachedThreshold={0.5}
            onEndReached={loadMore}
            ListFooterComponent={
              loadingMore ? (
                <View style={styles.footerSpinner}>
                  <ActivityIndicator color="#d97706" />
                </View>
              ) : !hasMore && results.length > PAGE_SIZE ? (
                <Text style={styles.footerEnd}>End of results</Text>
              ) : null
            }
            renderItem={({ item }) => {
              const thumb =
                item.images?.fixed_height_small?.url ??
                item.images?.fixed_height_downsampled?.url ??
                item.images?.fixed_height?.url ??
                ''
              if (!thumb) return null
              return (
                <Pressable
                  style={styles.tile}
                  onPress={() => handleSelect(item)}
                >
                  <Image
                    source={{ uri: thumb }}
                    style={styles.tileImage}
                    resizeMode="cover"
                  />
                </Pressable>
              )
            }}
          />
        )}

        <View style={styles.footer}>
          <Text style={styles.footerText}>Powered by GIPHY</Text>
        </View>
      </SafeAreaView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0c0a09' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomColor: '#1c1917',
    borderBottomWidth: 1,
  },
  cancelBtn: {
    paddingHorizontal: 4,
    paddingVertical: 4,
    minWidth: 70,
  },
  cancelBtnText: {
    color: '#d97706',
    fontSize: 15,
    fontWeight: '600',
  },
  title: {
    color: '#fafaf9',
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  headerSpacer: { minWidth: 70 },

  searchBar: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomColor: '#1c1917',
    borderBottomWidth: 1,
  },
  searchInput: {
    backgroundColor: '#1c1917',
    borderColor: '#292524',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#fafaf9',
    fontSize: 14,
  },

  errBox: {
    margin: 14,
    padding: 12,
    backgroundColor: '#7f1d1d',
    borderRadius: 8,
  },
  errText: { color: '#fca5a5', fontSize: 12 },

  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  empty: { padding: 40, alignItems: 'center' },
  emptyText: { color: '#78716c', fontSize: 13, textAlign: 'center' },

  grid: { padding: 6 },
  tile: {
    flex: 1 / 3,
    aspectRatio: 1,
    padding: 3,
  },
  tileImage: {
    width: '100%',
    height: '100%',
    borderRadius: 6,
    backgroundColor: '#1c1917',
  },

  footerSpinner: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  footerEnd: {
    paddingVertical: 16,
    textAlign: 'center',
    color: '#57534e',
    fontSize: 11,
  },

  footer: {
    paddingVertical: 6,
    borderTopColor: '#1c1917',
    borderTopWidth: 1,
    alignItems: 'center',
  },
  footerText: { color: '#57534e', fontSize: 9 },
})
