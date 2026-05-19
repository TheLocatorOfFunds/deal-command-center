/**
 * Team chat thread — message history + composer for one team_threads row.
 *
 * Feature parity with the web team chat (`src/app.jsx` TeamView):
 *   - Realtime message inserts/updates
 *   - Reactions (team_reactions): long-press bubble → emoji picker;
 *     tap an existing pill to toggle.
 *   - Attachments: inline image/GIF rendering. Storage-backed
 *     attachments are re-signed each load; Giphy attachments use the
 *     embedded `url` directly. (Files arriving in `team_messages.attachments`
 *     from the web app now render here — the previous "blank message
 *     with no media" regression is fixed.)
 *   - @mentions: composer detects `@<prefix>`, shows a picker of team
 *     profiles, inserts `@Name `. Stored as plain text — same convention
 *     as web.
 *   - Replies (parent_id): long-press → Reply; composer shows the quoted
 *     preview; reply bubbles render the parent body inline. Schema has
 *     supported this since phase 1; web hasn't built the UI yet, so
 *     mobile leads here.
 *   - Pull-to-refresh on the message list.
 *   - Jitsi `meet.jit.si/...` URLs in any message render as a tappable
 *     "📹 Join video call" button — hands off to the Jitsi Meet iOS app
 *     via Linking.openURL.
 *
 * Send: writes to `team_messages` directly. RLS verifies sender_id =
 * auth.uid() and admin/va role.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams } from 'expo-router'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'
import { extractJitsiUrls } from '../../lib/videoRooms'

const REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '🔥', '✅', '👀', '🤔']
const STORAGE_BUCKET = 'team-chat'
const SIGNED_URL_TTL_SECONDS = 60 * 60

type Thread = {
  id: string
  title: string
  thread_type: string
  lauren_enabled: boolean
}

type Attachment = {
  path?: string
  name?: string
  size?: number
  type?: string
  url?: string
  source?: string
  giphy_id?: string
}

type Msg = {
  id: string
  thread_id: string
  sender_id: string | null
  sender_kind: string
  body: string
  attachments: Attachment[] | null
  parent_id: string | null
  created_at: string
  edited_at: string | null
  deleted_at: string | null
}

type Profile = {
  id: string
  name: string | null
  display_name: string | null
}

type Reaction = {
  id: string
  message_id: string
  user_id: string
  emoji: string
}

export default function TeamThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { session } = useAuth()
  const userId = session?.user?.id ?? null
  const listRef = useRef<FlatList<Msg>>(null)
  const composerRef = useRef<TextInput>(null)

  const [thread, setThread] = useState<Thread | null>(null)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [authors, setAuthors] = useState<Map<string, Profile>>(new Map())
  const [reactions, setReactions] = useState<Map<string, Reaction[]>>(new Map())
  const [myKind, setMyKind] = useState<'admin' | 'va'>('admin')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  // Long-press action sheet (reactions + reply)
  const [actionForMsg, setActionForMsg] = useState<Msg | null>(null)

  // Reply state — when set, the composer shows a quoted preview and the
  // next send writes with parent_id = replyTo.id.
  const [replyTo, setReplyTo] = useState<Msg | null>(null)

  // @mention picker state
  const [mention, setMention] = useState<{
    prefix: string
    startPos: number
  } | null>(null)
  const [caret, setCaret] = useState(0)

  // Signed-URL cache keyed by storage path. Resolved lazily as
  // attachments render so we don't re-sign on every state update.
  const signedUrls = useRef<Map<string, { url: string; expires: number }>>(
    new Map(),
  )
  const [, forceSignedUrlRender] = useState(0)

  // ── Initial load ───────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!id) return
    setError(null)
    const [thRes, msgRes, meRes] = await Promise.all([
      supabase
        .from('team_threads')
        .select('id, title, thread_type, lauren_enabled')
        .eq('id', id)
        .maybeSingle(),
      supabase
        .from('team_messages')
        .select(
          'id, thread_id, sender_id, sender_kind, body, attachments, parent_id, created_at, edited_at, deleted_at',
        )
        .eq('thread_id', id)
        .is('deleted_at', null)
        .order('created_at', { ascending: true })
        .limit(500),
      userId
        ? supabase
            .from('profiles')
            .select('id, role')
            .eq('id', userId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ])
    if (thRes.error) {
      setError(thRes.error.message)
      setLoading(false)
      return
    }
    if (msgRes.error) {
      setError(msgRes.error.message)
      setLoading(false)
      return
    }
    setThread((thRes.data as Thread | null) ?? null)
    const newMsgs = (msgRes.data ?? []) as Msg[]
    setMsgs(newMsgs)
    setMyKind(
      (meRes.data as { role?: string } | null)?.role === 'va' ? 'va' : 'admin',
    )

    // Hydrate all admin/VA profiles (used for @mention picker + bubble labels)
    const { data: allProfs } = await supabase
      .from('profiles')
      .select('id, name, display_name')
      .in('role', ['admin', 'user', 'va'])
    const profMap = new Map<string, Profile>()
    for (const p of allProfs ?? []) {
      profMap.set(p.id as string, {
        id: p.id as string,
        name: (p.name as string) ?? null,
        display_name: (p.display_name as string) ?? null,
      })
    }
    setAuthors(profMap)

    // Reactions for these messages
    const msgIds = newMsgs.map((m) => m.id)
    if (msgIds.length > 0) {
      const { data: rxRows } = await supabase
        .from('team_reactions')
        .select('id, message_id, user_id, emoji')
        .in('message_id', msgIds)
      const rxMap = new Map<string, Reaction[]>()
      for (const r of rxRows ?? []) {
        const key = r.message_id as string
        const arr = rxMap.get(key) ?? []
        arr.push({
          id: r.id as string,
          message_id: key,
          user_id: r.user_id as string,
          emoji: r.emoji as string,
        })
        rxMap.set(key, arr)
      }
      setReactions(rxMap)
    } else {
      setReactions(new Map())
    }

    setLoading(false)
    setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 0)
  }, [id, userId])

  useEffect(() => {
    load()
  }, [load])

  // ── Realtime: messages + reactions ─────────────────────────────────
  useEffect(() => {
    if (!id) return
    const channel = supabase
      .channel(`team-thread-${id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'team_messages',
          filter: `thread_id=eq.${id}`,
        },
        (payload) => {
          const m = payload.new as Msg
          if (m.deleted_at) return
          setMsgs((prev) => {
            if (prev.some((x) => x.id === m.id)) return prev
            return [...prev, m]
          })
          setTimeout(
            () => listRef.current?.scrollToEnd({ animated: true }),
            50,
          )
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'team_messages',
          filter: `thread_id=eq.${id}`,
        },
        (payload) => {
          const m = payload.new as Msg
          setMsgs((prev) => prev.map((x) => (x.id === m.id ? m : x)))
        },
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [id])

  // Separate channel for reactions — table-level subscription (not
  // filterable by thread, so we filter on the client by checking the
  // message_id against our current msgs list).
  useEffect(() => {
    if (!id) return
    const channel = supabase
      .channel(`team-reactions-${id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'team_reactions' },
        async () => {
          // Reload the slice for current messages — cheap; the table is small
          setMsgs((prev) => {
            const ids = prev.map((m) => m.id)
            if (ids.length === 0) return prev
            supabase
              .from('team_reactions')
              .select('id, message_id, user_id, emoji')
              .in('message_id', ids)
              .then(({ data }) => {
                const rxMap = new Map<string, Reaction[]>()
                for (const r of data ?? []) {
                  const key = r.message_id as string
                  const arr = rxMap.get(key) ?? []
                  arr.push({
                    id: r.id as string,
                    message_id: key,
                    user_id: r.user_id as string,
                    emoji: r.emoji as string,
                  })
                  rxMap.set(key, arr)
                }
                setReactions(rxMap)
              })
            return prev
          })
        },
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [id])

  // ── Sign storage attachment URLs (cached) ──────────────────────────
  const getSignedUrl = useCallback(async (path: string): Promise<string | null> => {
    const cached = signedUrls.current.get(path)
    const now = Date.now()
    if (cached && cached.expires > now + 30_000) return cached.url
    const { data, error: signErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
    if (signErr || !data?.signedUrl) return null
    signedUrls.current.set(path, {
      url: data.signedUrl,
      expires: now + SIGNED_URL_TTL_SECONDS * 1000,
    })
    forceSignedUrlRender((n) => n + 1)
    return data.signedUrl
  }, [])

  // Eagerly sign all storage-backed attachments whenever msgs changes
  // so images appear without a "tap to load" step.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const paths = new Set<string>()
      for (const m of msgs) {
        for (const a of m.attachments ?? []) {
          if (a.path) paths.add(a.path)
        }
      }
      await Promise.all(
        Array.from(paths).map(async (p) => {
          if (cancelled) return
          await getSignedUrl(p)
        }),
      )
    })()
    return () => {
      cancelled = true
    }
  }, [msgs, getSignedUrl])

  // ── @mention autocomplete ──────────────────────────────────────────
  const onDraftChange = (text: string) => {
    setDraft(text)
    const before = text.slice(0, caret)
    const m = before.match(/(?:^|\s)@(\w*)$/)
    if (m) {
      setMention({
        prefix: m[1].toLowerCase(),
        startPos: caret - m[1].length - 1,
      })
    } else {
      setMention(null)
    }
  }

  const onSelectionChange = (e: any) => {
    const pos = e.nativeEvent.selection?.end ?? 0
    setCaret(pos)
  }

  const mentionSuggestions = useMemo(() => {
    if (!mention) return []
    const all = Array.from(authors.values())
      .filter((p) => p.id !== userId)
      .map((p) => ({
        id: p.id,
        label: p.display_name || p.name || 'Teammate',
      }))
    const q = mention.prefix
    return all
      .filter((c) => !q || c.label.toLowerCase().startsWith(q))
      .slice(0, 6)
  }, [mention, authors, userId])

  const insertMention = (label: string) => {
    if (!mention) return
    const before = draft.slice(0, mention.startPos)
    const after = draft.slice(caret)
    const insertion = '@' + label + ' '
    const next = before + insertion + after
    setDraft(next)
    setMention(null)
    setTimeout(() => composerRef.current?.focus(), 0)
  }

  // ── Send ───────────────────────────────────────────────────────────
  const send = async () => {
    const body = draft.trim()
    if (!body || sending || !userId || !id) return
    setSending(true)
    try {
      const row: Record<string, unknown> = {
        thread_id: id,
        sender_id: userId,
        sender_kind: myKind,
        body,
      }
      if (replyTo) row.parent_id = replyTo.id
      const { error: err } = await supabase.from('team_messages').insert(row)
      if (err) throw err
      setDraft('')
      setReplyTo(null)
      setMention(null)
      setTimeout(() => load(), 200)
    } catch (e) {
      Alert.alert(
        'Send failed',
        e instanceof Error ? e.message : 'Unknown error',
      )
    } finally {
      setSending(false)
    }
  }

  // ── Reactions ──────────────────────────────────────────────────────
  const toggleReaction = async (messageId: string, emoji: string) => {
    if (!userId) return
    const existing = (reactions.get(messageId) ?? []).find(
      (r) => r.user_id === userId && r.emoji === emoji,
    )
    // Optimistic update so the pill animates immediately
    setReactions((prev) => {
      const next = new Map(prev)
      const arr = (next.get(messageId) ?? []).slice()
      if (existing) {
        next.set(
          messageId,
          arr.filter((r) => r.id !== existing.id),
        )
      } else {
        arr.push({
          id: `optimistic-${Date.now()}`,
          message_id: messageId,
          user_id: userId,
          emoji,
        })
        next.set(messageId, arr)
      }
      return next
    })
    if (existing) {
      await supabase.from('team_reactions').delete().eq('id', existing.id)
    } else {
      await supabase
        .from('team_reactions')
        .insert({ message_id: messageId, user_id: userId, emoji })
    }
  }

  const title = useMemo(() => {
    if (!thread) return id ?? 'Thread'
    return (thread.thread_type === 'channel' ? '# ' : '') + thread.title
  }, [thread, id])

  const msgsById = useMemo(() => {
    const map = new Map<string, Msg>()
    for (const m of msgs) map.set(m.id, m)
    return map
  }, [msgs])

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <Stack.Screen
        options={{
          title,
          headerStyle: { backgroundColor: '#0c0a09' },
          headerTintColor: '#fafaf9',
        }}
      />

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color="#d97706" />
        </View>
      ) : error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>⚠ {error}</Text>
        </View>
      ) : (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
        >
          <FlatList
            ref={listRef}
            data={msgs}
            keyExtractor={(m) => m.id}
            contentContainerStyle={styles.list}
            onContentSizeChange={() =>
              listRef.current?.scrollToEnd({ animated: false })
            }
            refreshControl={
              <RefreshControl
                tintColor="#d97706"
                refreshing={refreshing}
                onRefresh={async () => {
                  setRefreshing(true)
                  await load()
                  setRefreshing(false)
                }}
              />
            }
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyText}>
                  No messages yet. Be the first.
                </Text>
              </View>
            }
            renderItem={({ item }) => (
              <MessageBubble
                msg={item}
                mine={!!(item.sender_id && item.sender_id === userId)}
                authors={authors}
                parent={
                  item.parent_id ? (msgsById.get(item.parent_id) ?? null) : null
                }
                reactions={reactions.get(item.id) ?? []}
                myUserId={userId}
                signedUrls={signedUrls.current}
                onToggleReaction={(emoji) => toggleReaction(item.id, emoji)}
                onLongPress={() => setActionForMsg(item)}
              />
            )}
          />

          {/* Reply preview */}
          {replyTo && (
            <View style={styles.replyPreview}>
              <View style={{ flex: 1 }}>
                <Text style={styles.replyPreviewLabel}>
                  Replying to {authorLabel(replyTo, authors)}
                </Text>
                <Text style={styles.replyPreviewBody} numberOfLines={2}>
                  {replyTo.body || '(attachment)'}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setReplyTo(null)}
                style={styles.replyPreviewClose}
              >
                <Text style={styles.replyPreviewCloseText}>×</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* @mention picker */}
          {mention && mentionSuggestions.length > 0 && (
            <View style={styles.mentionList}>
              <ScrollView keyboardShouldPersistTaps="handled">
                {mentionSuggestions.map((s) => (
                  <TouchableOpacity
                    key={s.id}
                    style={styles.mentionItem}
                    onPress={() => insertMention(s.label)}
                  >
                    <Text style={styles.mentionItemIcon}>👤</Text>
                    <Text style={styles.mentionItemLabel}>{s.label}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}

          <View style={styles.composer}>
            <TextInput
              ref={composerRef}
              style={styles.composerInput}
              value={draft}
              onChangeText={onDraftChange}
              onSelectionChange={onSelectionChange}
              placeholder={
                replyTo ? 'Reply to message…' : 'Message the team…'
              }
              placeholderTextColor="#78716c"
              multiline
              editable={!sending}
            />
            <TouchableOpacity
              style={[
                styles.sendBtn,
                (!draft.trim() || sending) && styles.sendBtnDisabled,
              ]}
              onPress={send}
              disabled={!draft.trim() || sending}
            >
              <Text style={styles.sendBtnText}>{sending ? '…' : 'Send'}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      )}

      {/* Long-press action sheet — reactions + reply */}
      <Modal
        transparent
        visible={!!actionForMsg}
        animationType="fade"
        onRequestClose={() => setActionForMsg(null)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setActionForMsg(null)}
        >
          <View style={styles.actionSheet}>
            <View style={styles.reactionRow}>
              {REACTION_EMOJIS.map((emoji) => (
                <TouchableOpacity
                  key={emoji}
                  style={styles.reactionBtn}
                  onPress={() => {
                    if (actionForMsg) toggleReaction(actionForMsg.id, emoji)
                    setActionForMsg(null)
                  }}
                >
                  <Text style={styles.reactionEmoji}>{emoji}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity
              style={styles.actionRow}
              onPress={() => {
                setReplyTo(actionForMsg)
                setActionForMsg(null)
                setTimeout(() => composerRef.current?.focus(), 50)
              }}
            >
              <Text style={styles.actionIcon}>↩</Text>
              <Text style={styles.actionLabel}>Reply</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionRow}
              onPress={() => setActionForMsg(null)}
            >
              <Text style={styles.actionIcon}>✕</Text>
              <Text style={styles.actionLabel}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  )
}

// ── Message bubble ─────────────────────────────────────────────────────

function MessageBubble({
  msg,
  mine,
  authors,
  parent,
  reactions,
  myUserId,
  signedUrls,
  onToggleReaction,
  onLongPress,
}: {
  msg: Msg
  mine: boolean
  authors: Map<string, Profile>
  parent: Msg | null
  reactions: Reaction[]
  myUserId: string | null
  signedUrls: Map<string, { url: string; expires: number }>
  onToggleReaction: (emoji: string) => void
  onLongPress: () => void
}) {
  const isLauren = msg.sender_kind === 'lauren'
  const author = authorLabel(msg, authors)
  const jitsi = extractJitsiUrls(msg.body)

  // Reaction aggregation: count per emoji + flag whether *I* reacted
  const reactionsByEmoji = new Map<
    string,
    { count: number; mine: boolean }
  >()
  for (const r of reactions) {
    const cur = reactionsByEmoji.get(r.emoji) ?? { count: 0, mine: false }
    cur.count += 1
    if (r.user_id === myUserId) cur.mine = true
    reactionsByEmoji.set(r.emoji, cur)
  }

  return (
    <View style={{ marginBottom: 10 }}>
      {!mine && (
        <Text style={styles.authorLabel}>
          {author}
          {isLauren ? ' 🤖' : ''}
        </Text>
      )}
      <Pressable
        onLongPress={onLongPress}
        delayLongPress={250}
        style={[
          styles.bubble,
          mine
            ? styles.bubbleOut
            : isLauren
              ? styles.bubbleLauren
              : styles.bubbleIn,
        ]}
      >
        {parent && (
          <View
            style={[
              styles.quotedReply,
              mine ? styles.quotedReplyOut : styles.quotedReplyIn,
            ]}
          >
            <Text
              style={[
                styles.quotedReplyAuthor,
                mine ? styles.quotedReplyAuthorOut : null,
              ]}
            >
              ↩ {authorLabel(parent, authors)}
            </Text>
            <Text
              numberOfLines={2}
              style={[
                styles.quotedReplyBody,
                mine ? styles.quotedReplyBodyOut : null,
              ]}
            >
              {parent.body || '(attachment)'}
            </Text>
          </View>
        )}

        {!!msg.body && (
          <Text
            style={
              mine
                ? styles.bubbleTextOut
                : isLauren
                  ? styles.bubbleTextLauren
                  : styles.bubbleTextIn
            }
          >
            {msg.body}
          </Text>
        )}

        {/* Attachments */}
        {Array.isArray(msg.attachments) && msg.attachments.length > 0 && (
          <View style={{ marginTop: 6, gap: 6 }}>
            {msg.attachments.map((a, i) => (
              <AttachmentView
                key={`${msg.id}-att-${i}`}
                attachment={a}
                signedUrls={signedUrls}
              />
            ))}
          </View>
        )}

        {/* Jitsi join links */}
        {jitsi.map((url) => (
          <TouchableOpacity
            key={url}
            style={styles.joinCallBtn}
            onPress={() => Linking.openURL(url)}
          >
            <Text style={styles.joinCallText}>📹 Join video call</Text>
          </TouchableOpacity>
        ))}

        <Text style={styles.bubbleMeta}>
          {formatRelative(msg.created_at)}
          {msg.edited_at ? ' · edited' : ''}
        </Text>
      </Pressable>

      {/* Reaction pills */}
      {reactionsByEmoji.size > 0 && (
        <View style={[styles.pillRow, mine ? { justifyContent: 'flex-end' } : null]}>
          {Array.from(reactionsByEmoji.entries()).map(([emoji, info]) => (
            <TouchableOpacity
              key={emoji}
              style={[styles.pill, info.mine ? styles.pillMine : null]}
              onPress={() => onToggleReaction(emoji)}
            >
              <Text style={styles.pillEmoji}>{emoji}</Text>
              <Text
                style={[styles.pillCount, info.mine ? styles.pillCountMine : null]}
              >
                {info.count}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  )
}

// ── Attachment view ────────────────────────────────────────────────────

function AttachmentView({
  attachment,
  signedUrls,
}: {
  attachment: Attachment
  signedUrls: Map<string, { url: string; expires: number }>
}) {
  const name = attachment.name ?? ''
  const type = attachment.type ?? ''
  const isImage =
    /^image\//.test(type) || /\.(jpe?g|png|webp|gif)$/i.test(name)

  // Storage-backed attachments use a signed URL; Giphy/external use `url`.
  let resolvedUrl: string | null = null
  if (attachment.path) {
    resolvedUrl = signedUrls.get(attachment.path)?.url ?? null
  } else if (attachment.url) {
    resolvedUrl = attachment.url
  }

  if (isImage && resolvedUrl) {
    return (
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => resolvedUrl && Linking.openURL(resolvedUrl)}
      >
        <Image
          source={{ uri: resolvedUrl }}
          style={styles.attachmentImage}
          resizeMode="cover"
        />
      </TouchableOpacity>
    )
  }

  // Non-image fallback — name + open link
  return (
    <TouchableOpacity
      style={styles.attachmentFile}
      onPress={() => resolvedUrl && Linking.openURL(resolvedUrl)}
      disabled={!resolvedUrl}
    >
      <Text style={styles.attachmentFileText}>
        📎 {name || 'attachment'}
        {!resolvedUrl ? ' (loading…)' : ''}
      </Text>
    </TouchableOpacity>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────

function authorLabel(msg: Msg, authors: Map<string, Profile>): string {
  if (msg.sender_kind === 'lauren') return 'Lauren'
  if (!msg.sender_id) return 'system'
  const p = authors.get(msg.sender_id)
  return p?.display_name || p?.name || 'team'
}

function formatRelative(iso: string): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  const now = Date.now()
  const sec = Math.max(0, Math.floor((now - then) / 1000))
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(iso).toLocaleDateString()
}

// ── Styles ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0c0a09' },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  errorBox: {
    margin: 14,
    padding: 14,
    backgroundColor: '#7f1d1d',
    borderRadius: 10,
  },
  errorText: { color: '#fca5a5', fontSize: 14 },
  list: { padding: 14, paddingBottom: 4 },
  empty: { padding: 40, alignItems: 'center' },
  emptyText: { color: '#78716c', fontSize: 14, textAlign: 'center' },
  authorLabel: {
    color: '#78716c',
    fontSize: 11,
    marginLeft: 4,
    marginBottom: 2,
    fontWeight: '600',
  },
  bubble: {
    maxWidth: '85%',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bubbleOut: { alignSelf: 'flex-end', backgroundColor: '#d97706' },
  bubbleIn: {
    alignSelf: 'flex-start',
    backgroundColor: '#1c1917',
    borderColor: '#292524',
    borderWidth: 1,
  },
  bubbleLauren: {
    alignSelf: 'flex-start',
    backgroundColor: '#1c1917',
    borderColor: '#7c3aed',
    borderWidth: 1,
  },
  bubbleTextOut: { color: '#0c0a09', fontSize: 15, lineHeight: 20 },
  bubbleTextIn: { color: '#fafaf9', fontSize: 15, lineHeight: 20 },
  bubbleTextLauren: { color: '#fafaf9', fontSize: 15, lineHeight: 20 },
  bubbleMeta: {
    color: '#78716c',
    fontSize: 10,
    marginTop: 4,
    opacity: 0.85,
  },

  quotedReply: {
    borderLeftWidth: 3,
    borderLeftColor: '#57534e',
    paddingLeft: 8,
    paddingVertical: 2,
    marginBottom: 6,
  },
  quotedReplyIn: { borderLeftColor: '#78716c' },
  quotedReplyOut: { borderLeftColor: '#0c0a09' },
  quotedReplyAuthor: {
    color: '#a8a29e',
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 1,
  },
  quotedReplyAuthorOut: { color: '#1c1917' },
  quotedReplyBody: {
    color: '#a8a29e',
    fontSize: 12,
    fontStyle: 'italic',
  },
  quotedReplyBodyOut: { color: '#1c1917' },

  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4,
    paddingHorizontal: 4,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#1c1917',
    borderColor: '#292524',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  pillMine: {
    backgroundColor: '#78350f44',
    borderColor: '#92400e',
  },
  pillEmoji: { fontSize: 13 },
  pillCount: { color: '#a8a29e', fontSize: 11, fontWeight: '600' },
  pillCountMine: { color: '#fbbf24' },

  attachmentImage: {
    width: 240,
    height: 240,
    borderRadius: 10,
    backgroundColor: '#0c0a09',
  },
  attachmentFile: {
    backgroundColor: '#0c0a09',
    borderColor: '#44403c',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  attachmentFileText: { color: '#fafaf9', fontSize: 13 },

  joinCallBtn: {
    marginTop: 6,
    backgroundColor: '#052e16',
    borderColor: '#16a34a',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  joinCallText: { color: '#86efac', fontSize: 12, fontWeight: '700' },

  replyPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1c1917',
    borderTopColor: '#292524',
    borderTopWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 10,
  },
  replyPreviewLabel: {
    color: '#fbbf24',
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 2,
  },
  replyPreviewBody: { color: '#a8a29e', fontSize: 12 },
  replyPreviewClose: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  replyPreviewCloseText: {
    color: '#78716c',
    fontSize: 22,
    fontWeight: '600',
  },

  mentionList: {
    backgroundColor: '#1c1917',
    borderColor: '#44403c',
    borderWidth: 1,
    borderRadius: 8,
    marginHorizontal: 10,
    marginBottom: 4,
    maxHeight: 200,
  },
  mentionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  mentionItemIcon: { fontSize: 16 },
  mentionItemLabel: { color: '#fafaf9', fontSize: 14, fontWeight: '600' },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 10,
    paddingVertical: 8,
    paddingBottom: 12,
    borderTopColor: '#1c1917',
    borderTopWidth: 1,
    backgroundColor: '#0c0a09',
    gap: 8,
  },
  composerInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    backgroundColor: '#1c1917',
    borderColor: '#292524',
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#fafaf9',
    fontSize: 15,
  },
  sendBtn: {
    backgroundColor: '#d97706',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendBtnDisabled: { backgroundColor: '#292524' },
  sendBtnText: { color: '#0c0a09', fontWeight: '700', fontSize: 14 },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
    paddingBottom: 30,
    paddingHorizontal: 14,
  },
  actionSheet: {
    backgroundColor: '#1c1917',
    borderRadius: 14,
    borderColor: '#292524',
    borderWidth: 1,
    padding: 10,
  },
  reactionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-around',
    paddingVertical: 6,
    paddingHorizontal: 4,
    marginBottom: 6,
  },
  reactionBtn: {
    padding: 8,
  },
  reactionEmoji: { fontSize: 28 },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderTopColor: '#292524',
    borderTopWidth: 1,
  },
  actionIcon: { color: '#fbbf24', fontSize: 18, width: 22, textAlign: 'center' },
  actionLabel: { color: '#fafaf9', fontSize: 15, fontWeight: '600' },
})
