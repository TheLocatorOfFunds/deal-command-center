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
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'
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

type DocketEvent = {
  id: string
  event_type: string | null
  event_date: string | null
  description: string | null
  litigation_stage: string | null
}

type Document = {
  id: string
  name: string | null
  path: string | null
  size: number | null
  extraction_status: string | null
  created_at: string | null
}

type AttorneyAssignment = {
  user_id: string | null
  email: string | null
  attorney_name?: string | null
  enabled: boolean | null
}

type Task = {
  id: number
  title: string | null
  done: boolean | null
  due_date: string | null
  assigned_to: string | null
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
  const { session } = useAuth()
  const { id } = useLocalSearchParams<{ id: string }>()
  const [deal, setDeal] = useState<Deal | null>(null)
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [contactLinks, setContactLinks] = useState<ContactLink[]>([])
  const [activity, setActivity] = useState<ActivityRow[]>([])
  const [comms, setComms] = useState<CommsItem[]>([])
  const [notes, setNotes] = useState<Note[]>([])
  const [documents, setDocuments] = useState<Document[]>([])
  const [docketEvents, setDocketEvents] = useState<DocketEvent[]>([])
  const [attorneys, setAttorneys] = useState<AttorneyAssignment[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setError(null)
    const [d, v, c, a, msgs, calls, n, docs, dock, att, tk] = await Promise.all([
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
      // Documents
      supabase
        .from('documents')
        .select('id, name, path, size, extraction_status, created_at')
        .eq('deal_id', id)
        .order('created_at', { ascending: false })
        .limit(20),
      // Docket events
      supabase
        .from('docket_events')
        .select('id, event_type, event_date, description, litigation_stage')
        .eq('deal_id', id)
        .order('event_date', { ascending: false })
        .limit(15),
      // Counsel / attorney assignments on this deal
      supabase
        .from('attorney_assignments')
        .select('user_id, email, enabled')
        .eq('deal_id', id),
      // Tasks
      supabase
        .from('tasks')
        .select('id, title, done, due_date, assigned_to')
        .eq('deal_id', id)
        .order('done', { ascending: true })
        .order('due_date', { ascending: true, nullsFirst: false })
        .limit(25),
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

      setDocuments((docs.data ?? []) as Document[])
      setDocketEvents((dock.data ?? []) as DocketEvent[])

      // Hydrate attorney names from profiles where we know the user_id
      const attRows = (att.data ?? []) as AttorneyAssignment[]
      const attUserIds = attRows
        .map((r) => r.user_id)
        .filter((x): x is string => !!x)
      const attMap = new Map<string, string>()
      if (attUserIds.length > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, name, display_name')
          .in('id', attUserIds)
        for (const p of profs ?? []) {
          attMap.set(
            p.id as string,
            (p.display_name as string) || (p.name as string) || '',
          )
        }
      }
      setAttorneys(
        attRows.map((r) => ({
          ...r,
          attorney_name: r.user_id ? attMap.get(r.user_id) : null,
        })),
      )

      setTasks((tk.data ?? []) as Task[])
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

  // Pull common case-context fields out of meta. Meta is a grab-bag so
  // every field is optional — render only what's actually there.
  const meta = (deal.meta ?? {}) as Record<string, unknown>
  const caseIntel = (meta.case_intel_summary as
    | { text?: string; generated_at?: string }
    | undefined)
  const facts: Array<{ label: string; value: string }> = []
  const pushFact = (label: string, raw: unknown, formatter?: (v: unknown) => string) => {
    if (raw === null || raw === undefined || raw === '') return
    facts.push({ label, value: formatter ? formatter(raw) : String(raw) })
  }
  const fmtMoney = (v: unknown) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v))
    if (!Number.isFinite(n)) return String(v)
    return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 })
  }
  const fmtDate = (v: unknown) => {
    const s = String(v)
    if (/^\d{4}-\d{2}-\d{2}/.test(s))
      return new Date(s).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    return s
  }
  pushFact('County', meta.county)
  pushFact('Case #', meta.courtCase)
  pushFact('Sale date', meta.saleDate, fmtDate)
  pushFact('Sale price', meta.salePrice, fmtMoney)
  pushFact('Judgment', meta.judgmentAmount ?? meta.totalDebt, fmtMoney)
  pushFact(
    'Est. surplus',
    meta.verifiedSurplus ?? meta.estimatedSurplus,
    fmtMoney,
  )
  pushFact('Court appraisal', meta.courtAppraisalValue, fmtMoney)
  pushFact('Min bid', meta.minimumBidAmount, fmtMoney)
  pushFact('Foreclosure filed', meta.foreclosureFileDate, fmtDate)

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
            <TouchableOpacity
              activeOpacity={0.6}
              onPress={() => openMaps(deal.address ?? '')}
            >
              <Text style={styles.dealAddress}>
                <Ionicons name="location" size={13} color="#d97706" />
                {'  '}
                {deal.address}
              </Text>
              <Text style={styles.addressHint}>Tap to open in Maps</Text>
            </TouchableOpacity>
          )}
          <View style={styles.pillRow}>
            {deal.type && (
              <View style={styles.pill}>
                <Text style={styles.pillText}>{deal.type}</Text>
              </View>
            )}
            {deal.status && (
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => openStatusPicker(deal, setDeal)}
              >
                <View
                  style={[
                    styles.pill,
                    { backgroundColor: statusColor(deal.status) },
                  ]}
                >
                  <Text style={styles.pillText}>{deal.status} ▾</Text>
                </View>
              </TouchableOpacity>
            )}
          </View>

          {/* Ask Lauren about this deal — seeds the Lauren tab with a
              prompt that includes this deal's id, letting her pull
              context via get_deal / get_deal_documents tools. */}
          <TouchableOpacity
            style={styles.laurenLink}
            activeOpacity={0.7}
            onPress={() => {
              const prompt = `Tell me everything I should know about deal ${deal.id}${
                deal.name ? ` (${deal.name})` : ''
              } before I call them.`
              router.push({
                pathname: '/(tabs)/lauren',
                params: { seed: prompt },
              })
            }}
          >
            <Ionicons name="sparkles" size={16} color="#7c3aed" />
            <Text style={styles.laurenLinkText}>
              Ask Lauren about this deal
            </Text>
          </TouchableOpacity>
        </View>

        {/* Welcome video — if Nathan recorded one for this client */}
        {(() => {
          const wv = (meta.welcome_video ?? {}) as {
            path?: string
            recorded_at?: string
          }
          if (!wv.path) return null
          return (
            <>
              <Text style={styles.sectionLabel}>Welcome video</Text>
              <TouchableOpacity
                style={[styles.section, styles.videoCard]}
                activeOpacity={0.7}
                onPress={async () => {
                  const { data, error: e } = await supabase.storage
                    .from('deal-docs')
                    .createSignedUrl(wv.path!, 60 * 10)
                  if (e || !data?.signedUrl) {
                    Alert.alert(
                      'Could not load',
                      e?.message ?? 'Video missing',
                    )
                    return
                  }
                  Linking.openURL(data.signedUrl).catch(() => {})
                }}
              >
                <View style={styles.playIcon}>
                  <Ionicons name="play" size={28} color="#0c0a09" />
                </View>
                <View style={{ flex: 1, marginLeft: 14 }}>
                  <Text style={styles.videoTitle}>Watch welcome video</Text>
                  <Text style={styles.videoSub}>
                    {wv.recorded_at
                      ? `Recorded ${formatRelative(wv.recorded_at)}`
                      : 'Recorded for this case'}
                  </Text>
                </View>
              </TouchableOpacity>
            </>
          )
        })()}

        {/* Case Intel — Claude's case briefing if generated */}
        {caseIntel?.text && (
          <>
            <Text style={styles.sectionLabel}>Case intelligence</Text>
            <View style={styles.section}>
              <CaseIntelBody text={caseIntel.text} />
              {caseIntel.generated_at && (
                <Text style={styles.intelMeta}>
                  Generated {formatRelative(caseIntel.generated_at)}
                </Text>
              )}
            </View>
          </>
        )}

        {/* Case facts — only renders if any meta fields are present */}
        {facts.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>Case facts</Text>
            <View style={styles.section}>
              <View style={styles.factsGrid}>
                {facts.map((f) => (
                  <View key={f.label} style={styles.factCell}>
                    <Text style={styles.factLabel}>{f.label}</Text>
                    <Text style={styles.factValue}>{f.value}</Text>
                  </View>
                ))}
              </View>
            </View>
          </>
        )}

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

        {/* Counsel — attorneys on this deal */}
        {attorneys.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>Counsel</Text>
            <View style={styles.section}>
              {attorneys.map((att, i) => (
                <View
                  key={`att-${att.user_id ?? att.email ?? i}`}
                  style={styles.contactRow}
                >
                  <Ionicons
                    name="briefcase-outline"
                    size={20}
                    color="#d97706"
                  />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={styles.contactName}>
                      {att.attorney_name || att.email || '(no name)'}
                    </Text>
                    <Text style={styles.contactSub}>
                      {att.enabled === false
                        ? 'Disabled'
                        : 'Attorney portal access'}
                    </Text>
                  </View>
                  {att.email && (
                    <TouchableOpacity
                      onPress={() =>
                        Linking.openURL(`mailto:${att.email}`).catch(() => {})
                      }
                    >
                      <Ionicons name="mail" size={20} color="#d97706" />
                    </TouchableOpacity>
                  )}
                </View>
              ))}
            </View>
          </>
        )}

        {/* Documents */}
        {documents.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>
              Documents · {documents.length}
            </Text>
            <View style={styles.section}>
              {documents.slice(0, 6).map((doc) => (
                <TouchableOpacity
                  key={doc.id}
                  style={styles.docRow}
                  activeOpacity={0.6}
                  onPress={async () => {
                    if (!doc.path) {
                      Alert.alert('No file', 'This document has no stored path.')
                      return
                    }
                    const { data, error: e } = await supabase.storage
                      .from('deal-docs')
                      .createSignedUrl(doc.path, 60 * 5)
                    if (e || !data?.signedUrl) {
                      Alert.alert(
                        'Could not open',
                        e?.message ?? 'Unknown error',
                      )
                      return
                    }
                    Linking.openURL(data.signedUrl).catch(() => {})
                  }}
                >
                  <Ionicons
                    name="document-text-outline"
                    size={20}
                    color="#a8a29e"
                  />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={styles.docTitle} numberOfLines={1}>
                      {doc.name ?? '(unnamed)'}
                    </Text>
                    <Text style={styles.docSub}>
                      {formatBytes(doc.size)}
                      {doc.created_at
                        ? ` · ${formatRelative(doc.created_at)}`
                        : ''}
                    </Text>
                  </View>
                  <Ionicons
                    name="chevron-forward"
                    size={20}
                    color="#57534e"
                  />
                </TouchableOpacity>
              ))}
              {documents.length > 6 && (
                <Text style={styles.moreText}>
                  + {documents.length - 6} more · view on web
                </Text>
              )}
            </View>
          </>
        )}

        {/* Docket events */}
        {docketEvents.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>
              Docket · {docketEvents.length}
            </Text>
            <View style={styles.section}>
              {docketEvents.map((evt) => (
                <View key={evt.id} style={styles.docketRow}>
                  <View style={styles.docketDate}>
                    <Text style={styles.docketDateText}>
                      {evt.event_date ? formatShortDate(evt.event_date) : '—'}
                    </Text>
                  </View>
                  <View style={{ flex: 1, marginLeft: 10 }}>
                    <Text style={styles.docketType}>
                      {evt.event_type ?? '(event)'}
                    </Text>
                    {evt.description && (
                      <Text
                        style={styles.docketDescription}
                        numberOfLines={2}
                      >
                        {evt.description}
                      </Text>
                    )}
                    {evt.litigation_stage && (
                      <Text style={styles.docketStage}>
                        {evt.litigation_stage}
                      </Text>
                    )}
                  </View>
                </View>
              ))}
            </View>
          </>
        )}

        {/* Tasks */}
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionLabel}>
            Tasks ·{' '}
            {tasks.length === 0
              ? '0'
              : `${tasks.filter((t) => !t.done).length} open`}
          </Text>
          <TouchableOpacity
            onPress={() =>
              router.push({
                pathname: '/quick/new-task',
                params: { deal_id: id, deal_name: deal.name ?? id },
              })
            }
            style={styles.addButton}
          >
            <Text style={styles.addButtonText}>+ Add</Text>
          </TouchableOpacity>
        </View>
        {tasks.length === 0 ? (
          <View style={styles.section}>
            <Text style={styles.emptyText}>
              No tasks yet. Tap "+ Add" to create one.
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.section}>
              {tasks.map((t) => (
                <TouchableOpacity
                  key={t.id}
                  style={styles.taskRow}
                  activeOpacity={0.6}
                  onPress={async () => {
                    // Toggle done state
                    const { error: e } = await supabase
                      .from('tasks')
                      .update({ done: !t.done })
                      .eq('id', t.id)
                    if (e) {
                      Alert.alert('Could not update', e.message)
                      return
                    }
                    setTasks((prev) =>
                      prev.map((x) =>
                        x.id === t.id ? { ...x, done: !x.done } : x,
                      ),
                    )
                  }}
                >
                  <View
                    style={[
                      styles.taskCheck,
                      t.done && styles.taskCheckDone,
                    ]}
                  >
                    {t.done && (
                      <Ionicons name="checkmark" size={14} color="#0c0a09" />
                    )}
                  </View>
                  <View style={{ flex: 1, marginLeft: 10 }}>
                    <Text
                      style={[
                        styles.taskTitle,
                        t.done && styles.taskTitleDone,
                      ]}
                      numberOfLines={2}
                    >
                      {t.title ?? '(untitled)'}
                    </Text>
                    {t.due_date && (
                      <Text style={styles.taskDue}>
                        Due {formatShortDate(t.due_date)}
                      </Text>
                    )}
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}

        {/* Notes */}
        {/* (anchor) */}
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
              <TouchableOpacity
                key={nn.id}
                activeOpacity={0.8}
                onLongPress={() => {
                  // Only the author can edit / delete. RLS would block
                  // others anyway, but show the right affordance.
                  const isMine = nn.author_id === session?.user?.id
                  if (!isMine) return
                  Alert.alert(
                    'Note',
                    'Edit or delete this note?',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Edit',
                        onPress: () => {
                          Alert.prompt(
                            'Edit note',
                            'Update the note body.',
                            [
                              { text: 'Cancel', style: 'cancel' },
                              {
                                text: 'Save',
                                onPress: async (next?: string) => {
                                  if (!next) return
                                  const trimmed = next.trim()
                                  if (!trimmed) return
                                  const { error: e } = await supabase
                                    .from('deal_notes')
                                    .update({ body: trimmed })
                                    .eq('id', nn.id)
                                  if (e) {
                                    Alert.alert('Could not save', e.message)
                                    return
                                  }
                                  setNotes((prev) =>
                                    prev.map((x) =>
                                      x.id === nn.id ? { ...x, body: trimmed } : x,
                                    ),
                                  )
                                },
                              },
                            ],
                            'plain-text',
                            nn.body ?? '',
                          )
                        },
                      },
                      {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: async () => {
                          const { error: e } = await supabase
                            .from('deal_notes')
                            .delete()
                            .eq('id', nn.id)
                          if (e) {
                            Alert.alert('Could not delete', e.message)
                            return
                          }
                          setNotes((prev) =>
                            prev.filter((x) => x.id !== nn.id),
                          )
                        },
                      },
                    ],
                  )
                }}
                style={styles.noteRow}
              >
                {nn.title && (
                  <Text style={styles.noteTitle}>{nn.title}</Text>
                )}
                <Text style={styles.noteBody}>{nn.body ?? ''}</Text>
                <Text style={styles.noteMeta}>
                  {nn.author_name ?? 'team'} ·{' '}
                  {nn.created_at ? formatRelative(nn.created_at) : ''}
                  {nn.author_id === session?.user?.id
                    ? ' · long-press to edit'
                    : ''}
                </Text>
              </TouchableOpacity>
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

// Tiny markdown renderer for the Claude-generated case intel text.
// Handles three things and nothing else: bold (**text**), bullet lines
// starting with "- ", and paragraph breaks. Anything fancier (links,
// nested lists, code) just renders as plain text.
function CaseIntelBody({ text }: { text: string }) {
  const blocks: React.ReactNode[] = []
  const lines = text.split(/\n+/)
  let bulletBuffer: string[] = []

  const flushBullets = (keyHint: string) => {
    if (bulletBuffer.length === 0) return
    blocks.push(
      <View key={`bul-${keyHint}`} style={{ marginTop: 6, marginBottom: 6 }}>
        {bulletBuffer.map((b, i) => (
          <View
            key={`bul-${keyHint}-${i}`}
            style={{ flexDirection: 'row', marginBottom: 6 }}
          >
            <Text style={styles.intelBullet}>•</Text>
            <View style={{ flex: 1 }}>{renderInline(b, `bul-${keyHint}-${i}`)}</View>
          </View>
        ))}
      </View>,
    )
    bulletBuffer = []
  }

  lines.forEach((raw, idx) => {
    const line = raw.trim()
    if (!line) return
    if (line.startsWith('- ')) {
      bulletBuffer.push(line.slice(2))
      return
    }
    flushBullets(`f-${idx}`)
    blocks.push(
      <View
        key={`p-${idx}`}
        style={{ marginBottom: 8 }}
      >
        {renderInline(line, `p-${idx}`)}
      </View>,
    )
  })
  flushBullets('end')

  return <>{blocks}</>
}

// Splits a line on **bold** markers and returns inline text spans.
function renderInline(line: string, keyPrefix: string) {
  const parts: React.ReactNode[] = []
  const segments = line.split(/(\*\*[^*]+\*\*)/g)
  segments.forEach((seg, i) => {
    if (!seg) return
    if (seg.startsWith('**') && seg.endsWith('**')) {
      parts.push(
        <Text key={`${keyPrefix}-${i}`} style={styles.intelBold}>
          {seg.slice(2, -2)}
        </Text>,
      )
    } else {
      parts.push(<Text key={`${keyPrefix}-${i}`}>{seg}</Text>)
    }
  })
  return <Text style={styles.intelText}>{parts}</Text>
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
  const emailable = !!props.email
  return (
    <View style={styles.contactRow}>
      <TouchableOpacity
        activeOpacity={callable ? 0.6 : 1}
        onPress={() => callable && props.onDial(props.phone)}
        style={{ flex: 1 }}
        disabled={!callable}
      >
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
        {props.email && (
          <Text style={styles.contactEmail}>{props.email}</Text>
        )}
      </TouchableOpacity>
      <View style={styles.contactActions}>
        {emailable && (
          <TouchableOpacity
            onPress={() =>
              Linking.openURL(`mailto:${props.email}`).catch(() => {})
            }
            style={styles.contactIconBtn}
          >
            <Ionicons name="mail" size={18} color="#d97706" />
          </TouchableOpacity>
        )}
        {callable && (
          <TouchableOpacity
            onPress={() => props.onDial(props.phone)}
            style={styles.contactIconBtn}
          >
            <Ionicons name="call" size={18} color="#d97706" />
          </TouchableOpacity>
        )}
      </View>
    </View>
  )
}

// Status options per type, ordered roughly by pipeline progression.
// Mirrors the web app's DEAL_STATUSES constant.
const STATUSES_BY_TYPE: Record<string, string[]> = {
  surplus: [
    'new-lead',
    'researching',
    'contacted',
    'fee-agreement',
    'filed',
    'served',
    'hearing-set',
    'hearing-passed',
    'order-issued',
    'paid',
    'archived',
    'cancelled',
  ],
  flip: [
    'new-lead',
    'researching',
    'under-contract',
    'rehab',
    'listed',
    'closed',
    'archived',
    'cancelled',
  ],
  wholesale: ['new-lead', 'under-contract', 'assigned', 'closed', 'archived'],
  rental: ['new-lead', 'under-contract', 'rented', 'closed', 'archived'],
  other: ['new-lead', 'in-progress', 'closed', 'archived'],
}

function openStatusPicker(
  deal: Deal,
  setDeal: React.Dispatch<React.SetStateAction<Deal | null>>,
) {
  const options =
    STATUSES_BY_TYPE[deal.type ?? 'other'] ?? STATUSES_BY_TYPE.other
  // iOS Alert.alert with N buttons. Cap at ~8 to avoid the system-
  // imposed action-sheet height limit.
  const trimmed = options.slice(0, 8)
  Alert.alert(
    'Change status',
    `Current: ${deal.status ?? '(none)'}`,
    [
      { text: 'Cancel', style: 'cancel' as const },
      ...trimmed
        .filter((s) => s !== deal.status)
        .slice(0, 7)
        .map((s) => ({
          text: s,
          onPress: async () => {
            const { error } = await supabase
              .from('deals')
              .update({ status: s })
              .eq('id', deal.id)
            if (error) {
              Alert.alert('Could not update', error.message)
              return
            }
            setDeal((p) => (p ? { ...p, status: s } : p))
          },
        })),
    ],
  )
}

function openMaps(addr: string) {
  if (!addr) return
  const q = encodeURIComponent(addr)
  // Apple Maps on iOS; falls back to https on other platforms
  Linking.openURL(`https://maps.apple.com/?q=${q}`).catch(() =>
    Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${q}`),
  )
}

// Status color map matching the web app's STATUS_COLORS roughly. Anything
// not in the map gets a neutral charcoal pill.
const STATUS_COLORS: Record<string, string> = {
  'new-lead': '#1e40af',          // blue
  'researching': '#6d28d9',        // purple
  'contacted': '#0f766e',          // teal
  'fee-agreement': '#0e7490',      // cyan
  'filed': '#a16207',              // amber
  'served': '#a16207',
  'hearing-set': '#a16207',
  'hearing-passed': '#92400e',
  'order-issued': '#15803d',       // green
  'paid': '#15803d',
  'archived': '#44403c',
  'under-contract': '#9333ea',
  'closed': '#15803d',
  'cancelled': '#7f1d1d',
}
function statusColor(s: string | null | undefined) {
  if (!s) return '#7c2d12'
  return STATUS_COLORS[s] ?? '#7c2d12'
}

function formatBytes(b: number | null | undefined): string {
  if (b == null) return ''
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

function formatShortDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
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
  contactEmail: { color: '#a8a29e', fontSize: 12, marginTop: 2 },
  contactActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 6 },
  contactIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#0c0a09',
    alignItems: 'center',
    justifyContent: 'center',
  },
  callIcon: { fontSize: 22, marginLeft: 10 },
  activityRow: {
    paddingVertical: 8,
    borderBottomColor: '#292524',
    borderBottomWidth: 1,
  },
  activityAction: { color: '#d6d3d1', fontSize: 13, lineHeight: 18 },
  activityTime: { color: '#78716c', fontSize: 11, marginTop: 2 },
  addressHint: { color: '#78716c', fontSize: 11, marginTop: 2 },
  videoCard: { flexDirection: 'row', alignItems: 'center' },
  playIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#d97706',
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoTitle: { color: '#fafaf9', fontSize: 16, fontWeight: '700' },
  videoSub: { color: '#a8a29e', fontSize: 12, marginTop: 2 },
  laurenLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#0c0a09',
    borderRadius: 10,
    borderColor: '#7c3aed44',
    borderWidth: 1,
  },
  laurenLinkText: { color: '#d6d3d1', fontSize: 13, fontWeight: '600' },
  taskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomColor: '#292524',
    borderBottomWidth: 1,
  },
  taskCheck: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderColor: '#57534e',
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskCheckDone: { backgroundColor: '#d97706', borderColor: '#d97706' },
  taskTitle: { color: '#fafaf9', fontSize: 14 },
  taskTitleDone: {
    color: '#78716c',
    textDecorationLine: 'line-through',
  },
  taskDue: { color: '#d97706', fontSize: 11, marginTop: 2, fontWeight: '600' },
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomColor: '#292524',
    borderBottomWidth: 1,
  },
  docTitle: { color: '#fafaf9', fontSize: 14, fontWeight: '500' },
  docSub: { color: '#78716c', fontSize: 11, marginTop: 2 },
  moreText: {
    color: '#78716c',
    fontSize: 12,
    marginTop: 8,
    paddingHorizontal: 4,
    fontStyle: 'italic',
  },
  docketRow: {
    flexDirection: 'row',
    paddingVertical: 10,
    borderBottomColor: '#292524',
    borderBottomWidth: 1,
  },
  docketDate: {
    width: 56,
    paddingTop: 2,
  },
  docketDateText: {
    color: '#d97706',
    fontSize: 12,
    fontWeight: '700',
  },
  docketType: { color: '#fafaf9', fontSize: 14, fontWeight: '500' },
  docketDescription: { color: '#a8a29e', fontSize: 12, marginTop: 2, lineHeight: 17 },
  docketStage: {
    color: '#78716c',
    fontSize: 10,
    marginTop: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '600',
  },
  intelText: { color: '#d6d3d1', fontSize: 14, lineHeight: 21 },
  intelBold: { color: '#fafaf9', fontWeight: '700' },
  intelBullet: {
    color: '#d97706',
    fontSize: 16,
    marginRight: 8,
    marginTop: -1,
    width: 12,
  },
  intelMeta: {
    color: '#57534e',
    fontSize: 11,
    marginTop: 8,
    fontStyle: 'italic',
  },
  factsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    margin: -6,
  },
  factCell: {
    width: '50%',
    paddingHorizontal: 6,
    paddingVertical: 8,
  },
  factLabel: {
    color: '#78716c',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  factValue: { color: '#fafaf9', fontSize: 14, fontWeight: '600' },
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
