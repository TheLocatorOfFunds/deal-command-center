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
 */

import { useEffect, useState } from 'react'
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
  const [err, setErr] = useState<string | null>(null)

  // Reset when the modal opens
  useEffect(() => {
    if (!visible) return
    setQuery('')
    setErr(null)
  }, [visible])

  // Search (debounced) — load trending on empty query
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const timer = setTimeout(async () => {
      setLoading(true)
      setErr(null)
      const url = query.trim()
        ? `${GIPHY_SEARCH_URL}?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(query.trim())}&limit=24&rating=pg-13`
        : `${GIPHY_TRENDING_URL}?api_key=${GIPHY_API_KEY}&limit=24&rating=pg-13`
      try {
        const resp = await fetch(url)
        if (!resp.ok) throw new Error(`GIPHY HTTP ${resp.status}`)
        const json = await resp.json()
        if (!cancelled) setResults((json?.data ?? []) as GiphyResult[])
      } catch (e) {
        if (!cancelled)
          setErr(e instanceof Error ? e.message : 'Failed to load GIFs')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, query.trim() ? 250 : 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, visible])

  const handleSelect = (g: GiphyResult) => {
    const full =
      g.images?.fixed_height?.url ?? g.images?.original?.url ?? ''
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
      transparent={false}
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <Text style={styles.title}>🎬 GIPHY</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Text style={styles.closeBtnText}>Done</Text>
          </TouchableOpacity>
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
            keyExtractor={(g) => g.id}
            numColumns={3}
            contentContainerStyle={styles.grid}
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
    paddingVertical: 10,
    borderBottomColor: '#1c1917',
    borderBottomWidth: 1,
  },
  title: { color: '#fafaf9', fontSize: 16, fontWeight: '700' },
  closeBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  closeBtnText: { color: '#d97706', fontSize: 14, fontWeight: '700' },

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

  footer: {
    paddingVertical: 6,
    borderTopColor: '#1c1917',
    borderTopWidth: 1,
    alignItems: 'center',
  },
  footerText: { color: '#57534e', fontSize: 9 },
})
