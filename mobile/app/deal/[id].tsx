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
import { supabase } from '../../lib/supabase'

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

export default function DealDetailScreen() {
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const [deal, setDeal] = useState<Deal | null>(null)
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [contactLinks, setContactLinks] = useState<ContactLink[]>([])
  const [activity, setActivity] = useState<ActivityRow[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setError(null)
    const [d, v, c, a] = await Promise.all([
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
    ])
    const firstErr = d.error || v.error || c.error || a.error
    if (firstErr) {
      setError(firstErr.message)
    } else {
      setDeal((d.data as Deal | null) ?? null)
      setVendors((v.data ?? []) as Vendor[])
      setContactLinks((c.data ?? []) as unknown as ContactLink[])
      setActivity((a.data ?? []) as ActivityRow[])
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

  const dial = (phone: string | null | undefined) => {
    if (!phone) return
    const digits = phone.replace(/[^\d+]/g, '')
    if (!digits) return
    Linking.openURL(`tel:${digits}`).catch(() => {
      // Native dialer not available (e.g. iPad without cellular).
      // In Phase 2 this fallback becomes "open Twilio Voice in-app call".
    })
  }

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
})
