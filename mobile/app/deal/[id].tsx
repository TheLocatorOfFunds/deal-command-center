/**
 * Deal detail screen — phone-sized read-only view of one deal.
 *
 * The "I'm texting Todd, I want to see shit about him" view. Pulls the
 * deal row plus everything you'd want before calling someone:
 *   - status / address / type
 *   - claimant + attorney + per-deal vendors (tappable phone numbers)
 *   - company-wide contacts linked via contact_deals (tappable too)
 *   - last 25 activity rows for catch-up
 *
 * Phone-tap currently fires `Linking.openURL('tel:...')` — opens the
 * native iPhone dialer. Phase 2 (EAS dev build) replaces this with the
 * Twilio Voice SDK so the call screen can show the deal context
 * mid-call and the call auto-logs to `activity`.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { supabase } from '../../lib/supabase'
import { placeCall, saveUserCellPhone } from '../../lib/dial'

type Deal = {
  id: string
  type: string | null
  status: string | null
  name: string | null
  address: string | null
  meta: Record<string, unknown> | null
  updated_at: string | null
}

type Vendor = {
  id: string
  name: string | null
  role: string | null
  phone: string | null
  email: string | null
}

type ContactLink = {
  relationship: string | null
  contacts: {
    id: string
    name: string | null
    company: string | null
    phone: string | null
    email: string | null
    kind: string | null
    do_not_call: boolean | null
  } | null
}

type ActivityRow = {
  id: number
  action: string | null
  created_at: string | null
}

type Note = {
  id: string
  title: string | null
  body: string | null
  author_id: string | null
  author_name?: string | null
  created_at: string | null
}

type CommsItem = {
  kind: 'sms' | 'call'
  id: string
  direction: string
  body: string
  status: string | null
  duration_seconds?: number | null
  thread_key?: string | null
  at: string
}

export default function DealDetailScreen() {
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const [deal, setDeal] = useState<Deal | null>(null)
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [contactLinks, setContactLinks] = useState<ContactLink[]>([])
  const [activity, setActivity] = useState<ActivityRow[]>([])
  const [comms, setComms] = useState<CommsItem[]>([])
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setError(null)
    const [d, v, c, a, msgs, calls, n] = await Promise.all([
      supabase
        .from('deals')
        .select('id, type, status, name, address, meta, updated_at')
        .eq('id', id)
        .maybeSingle(),
      supabase
        .from('vendors')
        .select('id, name, role, phone, email')
        .eq('deal_id', id)
        .order('name'),
      supabase
        .from('contact_deals')
        .select(
          'relationship, contacts ( id, name, company, phone, email, kind, do_not_call )',
        )
        .eq('deal_id', id),
      supabase
        .from('activity')
        .select('id, action, created_at')
        .eq('deal_id', id)
        .order('created_at', { ascending: false })
        .limit(25),
      // Last 10 SMS for this deal
      supabase
        .from('messages_outbound')
        .select('id, direction, body, status, thread_key, created_at')
        .eq('deal_id', id)
        .order('created_at', { ascending: false })
        .limit(10),
      // Last 10 calls for this deal
      supabase
        .from('call_logs')
        .select(
          'id, direction, status, duration_seconds, thread_key, started_at, ended_at',
        )
        .eq('deal_id', id)
        .order('started_at', { ascending: false })
        .limit(10),
      // Notes on this deal
      supabase
        .from('deal_notes')
        .select('id, title, body, author_id, created_at')
        .eq('deal_id', id)
        .order('created_at', { ascending: false })
        .limit(20),
    ])
    const firstErr =
      d.error ||
      v.error ||
      c.error ||
      a.error ||
      msgs.error ||
      calls.error ||
      n.error
    if (firstErr) {
      setError(firstErr.message)
    } else {
      setDeal((d.data as Deal | null) ?? null)
      setVendors((v.data ?? []) as Vendor[])
      setContactLinks((c.data ?? []) as unknown as ContactLink[])
      setActivity((a.data ?? []) as ActivityRow[])

      // Merge messages + calls into one chronological comms timeline.
      const merged: CommsItem[] = []
      for (const m of (msgs.data ?? []) as Array<{
        id: string
        direction: string | null
        body: string | null
        status: string | null
        thread_key: string | null
        created_at: string | null
      }>) {
        merged.push({
          kind: 'sms',
          id: m.id,
          direction: m.direction ?? 'unknown',
          body: m.body ?? '',
          status: m.status,
          thread_key: m.thread_key,
          at: m.created_at ?? '',
        })
      }
      for (const cl of (calls.data ?? []) as Array<{
        id: string
        direction: string | null
        status: string | null
        duration_seconds: number | null
        thread_key: string | null
        started_at: string | null
      }>) {
        merged.push({
          kind: 'call',
          id: cl.id,
          direction: cl.direction ?? 'unknown',
          body: cl.status ?? 'call',
          status: cl.status,
          duration_seconds: cl.duration_seconds,
          thread_key: cl.thread_key,
          at: cl.started_at ?? '',
        })
      }
      merged.sort(
        (x, y) => new Date(y.at).getTime() - new Date(x.at).getTime(),
      )
      setComms(merged.slice(0, 15))

      // Hydrate note authors
      const rawNotes = (n.data ?? []) as Note[]
      const authorIds = Array.from(
        new Set(
          rawNotes
            .map((nn) => nn.author_id)
            .filter((x): x is string => !!x),
        ),
      )
      const authorMap = new Map<string, string>()
      if (authorIds.length > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, name, display_name')
          .in('id', authorIds)
        for (const p of profs ?? []) {
          authorMap.set(
            p.id as string,
            (p.display_name as string) || (p.name as string) || 'team',
          )
        }
      }
      setNotes(
        rawNotes.map((nn) => ({
          ...nn,
          author_name: nn.author_id ? authorMap.get(nn.author_id) : null,
        })),
      )
    }
    setLoading(false)
    setRefreshing(false)
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  const onRefresh = () => {
    setRefreshing(true)
    load()
  }

  const dial = useCallback(
    async (phone: string | null | undefined) => {
      if (!phone) return
      const result = await placeCall(phone, { dealId: id })

      if (result.ok) {
        Alert.alert(
          'Calling…',
          'Your phone will ring shortly. Answer to connect to the other party. Outgoing caller ID is the FundLocators business number.',
        )
        return
      }

      if (result.error === 'cell_phone_required') {
        // First-time setup. Prompt for the user's cell, save to
        // profiles.phone, then retry the call automatically.
        Alert.prompt(
          'Set your cell phone',
          'We need your cell to bridge calls through Twilio. Enter the number you want to ring when you tap to call.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Save & call',
              onPress: async (entered?: string) => {
                if (!entered) return
                const saved = await saveUserCellPhone(entered)
                if (!saved.ok) {
                  Alert.alert('Could not save', saved.message ?? '')
                  return
                }
                // retry
                const retry = await placeCall(phone, { dealId: id })
                if (retry.ok) {
                  Alert.alert('Calling…', retry.message)
                } else {
                  Alert.alert('Call failed', retry.message)
                }
              },
            },
          ],
          'plain-text',
          '',
          'phone-pad',
        )
        return
      }

      if (result.error === 'recipient_on_dnd') {
        Alert.alert('Do not call', result.message)
        return
      }

      Alert.alert('Call failed', result.message)
    },
    [id],
  )

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ title: id ?? 'Deal' }} />
        <View style={styles.loading}>
          <ActivityIndicator color="#d97706" />
        </View>
      </SafeAreaView>
    )
  }

  if (error || !deal) {
    return (
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ title: id ?? 'Deal' }} />
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>
            {error ? `⚠ ${error}` : '⚠ Deal not found'}
          </Text>
          <TouchableOpacity onPress={() => router.back()} style={styles.retry}>
            <Text style={styles.retryText}>← Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    )
  }

  const hasContacts = vendors.length > 0 || contactLinks.length > 0

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <Stack.Screen
        options={{
          title: deal.name ?? deal.id,
          headerStyle: { backgroundColor: '#0c0a09' },
          headerTintColor: '#fafaf9',
        }}
      />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            tintColor="#d97706"
            refreshing={refreshing}
            onRefresh={onRefresh}
          />
        }
      >
        {/* Header card */}
        <View style={styles.section}>
          <Text style={styles.dealName}>{deal.name ?? deal.id}</Text>
          {deal.address && (
            <Text style={styles.dealAddress}>{deal.address}</Text>
          )}
          <View style={styles.pillRow}>
            {deal.type && (
              <View style={styles.pill}>
                <Text style={styles.pillText}>{deal.type}</Text>
              </View>
            )}
            {deal.status && (
              <View style={[styles.pill, styles.pillStatus]}>
                <Text style={styles.pillText}>{deal.status}</Text>
              </View>
            )}
          </View>
        </View>

        {/* Contacts — vendors (per-deal) + contacts (company-wide) */}
        <Text style={styles.sectionLabel}>People · tap to call</Text>
        <View style={styles.section}>
          {!hasContacts && (
            <Text style={styles.emptyText}>
              No contacts linked. Add vendors or link contacts on the web.
            </Text>
          )}
          {vendors.map((v) => (
            <ContactRow
              key={`v-${v.id}`}
              name={v.name ?? '(no name)'}
              subtitle={v.role ?? 'vendor'}
              phone={v.phone}
              email={v.email}
              onDial={dial}
            />
          ))}
          {contactLinks.map((cl, idx) =>
            cl.contacts ? (
              <ContactRow
                key={`c-${cl.contacts.id ?? idx}`}
                name={cl.contacts.name ?? '(no name)'}
                subtitle={
                  cl.contacts.company ||
                  cl.relationship ||
                  cl.contacts.kind ||
                  'contact'
                }
                phone={cl.contacts.phone}
                email={cl.contacts.email}
                doNotCall={cl.contacts.do_not_call}
                onDial={dial}
              />
            ) : null,
          )}
        </View>

        {/* Notes */}
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionLabel}>Notes · {notes.length}</Text>
          <TouchableOpacity
            onPress={() =>
              router.push({
                pathname: '/quick/note',
                params: { deal_id: id, deal_name: deal.name ?? id },
              })
            }
            style={styles.addButton}
          >
            <Text style={styles.addButtonText}>+ Add</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.section}>
          {notes.length === 0 ? (
            <Text style={styles.emptyText}>
              No notes yet. Tap "+ Add" to drop one.
            </Text>
          ) : (
            notes.map((nn) => (
              <View key={nn.id} style={styles.noteRow}>
                {nn.title && (
                  <Text style={styles.noteTitle}>{nn.title}</Text>
                )}
                <Text style={styles.noteBody}>{nn.body ?? ''}</Text>
                <Text style={styles.noteMeta}>
                  {nn.author_name ?? 'team'} ·{' '}
                  {nn.created_at ? formatRelative(nn.created_at) : ''}
                </Text>
              </View>
            ))
          )}
        </View>

        {/* Comms timeline — calls + texts merged chronologically */}
        <Text style={styles.sectionLabel}>Comms · last 15</Text>
        <View style={styles.section}>
          {comms.length === 0 ? (
            <Text style={styles.emptyText}>
              No calls or texts on this deal yet.
            </Text>
          ) : (
            comms.map((item) => {
              const outbound = item.direction === 'outbound'
              const Icon = item.kind === 'call' ? '📞' : '💬'
              const tappable = item.kind === 'sms' && !!item.thread_key
              return (
                <TouchableOpacity
                  key={`${item.kind}-${item.id}`}
                  style={styles.commsRow}
                  disabled={!tappable}
                  activeOpacity={tappable ? 0.6 : 1}
                  onPress={() => {
                    if (tappable && item.thread_key) {
                      router.push({
                        pathname: '/thread/[key]',
                        params: { key: item.thread_key },
                      })
                    }
                  }}
                >
                  <Text style={styles.commsIcon}>{Icon}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.commsLine} numberOfLines={2}>
                      <Text style={styles.commsDir}>
                        {outbound ? '→ ' : '← '}
                      </Text>
                      {item.kind === 'call'
                        ? formatCall(item)
                        : item.body || '(empty)'}
                    </Text>
                    <Text style={styles.commsMeta}>
                      {formatRelative(item.at)}
                      {item.status && item.kind === 'sms' && outbound
                        ? ` · ${item.status}`
                        : ''}
                    </Text>
                  </View>
                  {tappable && <Text style={styles.commsChev}>›</Text>}
                </TouchableOpacity>
              )
            })
          )}
        </View>

        {/* Recent activity */}
        <Text style={styles.sectionLabel}>Recent activity</Text>
        <View style={styles.section}>
          {activity.length === 0 ? (
            <Text style={styles.emptyText}>No activity logged yet.</Text>
          ) : (
            activity.map((a) => (
              <View key={a.id} style={styles.activityRow}>
                <Text style={styles.activityAction} numberOfLines={3}>
                  {a.action ?? '(no action)'}
                </Text>
                <Text style={styles.activityTime}>
                  {a.created_at ? formatRelative(a.created_at) : ''}
                </Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

function ContactRow(props: {
  name: string
  subtitle: string
  phone: string | null | undefined
  email: string | null | undefined
  doNotCall?: boolean | null
  onDial: (phone: string | null | undefined) => void
}) {
  const callable = !!props.phone && !props.doNotCall
  return (
    <TouchableOpacity
      activeOpacity={callable ? 0.6 : 1}
      onPress={() => callable && props.onDial(props.phone)}
      style={styles.contactRow}
      disabled={!callable}
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.contactName}>{props.name}</Text>
        <Text style={styles.contactSub}>{props.subtitle}</Text>
        {props.phone && (
          <Text
            style={[styles.contactPhone, !callable && styles.contactPhoneDnd]}
          >
            {props.phone}
            {props.doNotCall ? ' · DO NOT CALL' : ''}
          </Text>
        )}
      </View>
      {callable && <Text style={styles.callIcon}>📞</Text>}
    </TouchableOpacity>
  )
}

function formatCall(item: CommsItem): string {
  const dur = item.duration_seconds ?? 0
  const status = item.status ?? 'call'
  if (status === 'completed' && dur > 0) {
    const min = Math.floor(dur / 60)
    const sec = dur % 60
    return min > 0 ? `${min}m ${sec}s call` : `${sec}s call`
  }
  if (status === 'no-answer' || status === 'busy') return 'missed call'
  if (status === 'ringing') return 'call in progress'
  return `${status} call`
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  const now = Date.now()
  const sec = Math.max(0, Math.floor((now - then) / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(iso).toLocaleDateString()
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0c0a09' },
  scrollContent: { padding: 14, paddingBottom: 40 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  errorBox: {
    margin: 14,
    padding: 14,
    backgroundColor: '#7f1d1d',
    borderRadius: 10,
  },
  errorText: { color: '#fca5a5', fontSize: 14 },
  retry: {
    marginTop: 10,
    backgroundColor: '#0c0a09',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  retryText: { color: '#fca5a5', fontSize: 14, fontWeight: '600' },
  section: {
    backgroundColor: '#1c1917',
    borderRadius: 12,
    borderColor: '#292524',
    borderWidth: 1,
    padding: 14,
    marginBottom: 14,
  },
  sectionLabel: {
    color: '#78716c',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 8,
    marginTop: 4,
    paddingHorizontal: 4,
  },
  dealName: { color: '#fafaf9', fontSize: 20, fontWeight: '700' },
  dealAddress: { color: '#a8a29e', fontSize: 14, marginTop: 4 },
  pillRow: { flexDirection: 'row', marginTop: 12, gap: 8 },
  pill: {
    backgroundColor: '#292524',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  pillStatus: { backgroundColor: '#7c2d12' },
  pillText: { color: '#fafaf9', fontSize: 11, fontWeight: '600' },
  emptyText: { color: '#78716c', fontSize: 13, paddingVertical: 4 },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomColor: '#292524',
    borderBottomWidth: 1,
  },
  contactName: { color: '#fafaf9', fontSize: 15, fontWeight: '600' },
  contactSub: { color: '#a8a29e', fontSize: 12, marginTop: 2 },
  contactPhone: { color: '#d97706', fontSize: 13, marginTop: 4, fontWeight: '600' },
  contactPhoneDnd: { color: '#78716c', textDecorationLine: 'line-through' },
  callIcon: { fontSize: 22, marginLeft: 10 },
  activityRow: {
    paddingVertical: 8,
    borderBottomColor: '#292524',
    borderBottomWidth: 1,
  },
  activityAction: { color: '#d6d3d1', fontSize: 13, lineHeight: 18 },
  activityTime: { color: '#78716c', fontSize: 11, marginTop: 2 },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  addButton: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#292524',
    borderRadius: 999,
    marginBottom: 6,
  },
  addButtonText: { color: '#d97706', fontSize: 11, fontWeight: '700' },
  noteRow: {
    paddingVertical: 10,
    borderBottomColor: '#292524',
    borderBottomWidth: 1,
  },
  noteTitle: {
    color: '#fafaf9',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  noteBody: { color: '#d6d3d1', fontSize: 14, lineHeight: 20 },
  noteMeta: { color: '#78716c', fontSize: 11, marginTop: 4 },
  commsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomColor: '#292524',
    borderBottomWidth: 1,
    gap: 10,
  },
  commsIcon: { fontSize: 18 },
  commsLine: { color: '#d6d3d1', fontSize: 14, lineHeight: 20 },
  commsDir: { color: '#a8a29e', fontWeight: '600' },
  commsMeta: { color: '#78716c', fontSize: 11, marginTop: 2 },
  commsChev: { color: '#57534e', fontSize: 22 },
})
