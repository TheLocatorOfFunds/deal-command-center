/**
 * Notification system client — read/write helpers + badge wiring.
 *
 * Backed by the `notifications` table + `mark_*_read` RPCs from migration
 * 20260516120000_notifications_system. See docs/MOBILE_NOTIFICATION_SYSTEM.md.
 *
 * Three pieces:
 *   1. `useUnreadCount()` — realtime hook that subscribes to the
 *      `notifications` table for the signed-in user, returns the current
 *      unread count. Drives the iOS app icon badge via setBadgeCountAsync.
 *   2. `useNotificationFeed()` — feed for the notification center screen,
 *      loads the most recent 50 notifications, subscribes for live updates.
 *   3. Read-tracking helpers: markRead, markAllRead, markDealRead,
 *      markThreadRead — wrap the SQL RPCs with TS types.
 *
 * Graceful degradation: if the `notifications` table doesn't exist yet
 * (Justin hasn't applied the migration), every query returns empty/0 and
 * we log to console. Build 7 ships with this, then the migration is
 * applied separately, then notifications start flowing — no app rebuild
 * required.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import * as Notifications from 'expo-notifications'
import { supabase, chanName } from './supabase'

export type NotificationKind =
  | 'inbound_sms'
  | 'docket_event'
  | 'team_message'
  | 'deal_status_change'
  | 'missed_call'
  | 'system_alert'

export type NotificationRow = {
  id: string
  user_id: string
  kind: NotificationKind
  deal_id: string | null
  thread_id: string | null
  title: string
  body: string | null
  data: Record<string, unknown>
  created_at: string
  read_at: string | null
}

/**
 * Subscribes to the signed-in user's notifications and returns the
 * current unread count. Also updates the iOS app icon badge whenever
 * the count changes.
 *
 * Uses Postgres realtime — when the trigger inserts a new row for the
 * current user, the count increments and the badge updates in real time
 * even when the user is on another screen.
 */
export function useUnreadCount(userId: string | undefined | null): number {
  const [count, setCount] = useState(0)
  const lastSetRef = useRef<number>(-1)

  const refresh = useCallback(async () => {
    if (!userId) return
    const { data, error } = await supabase
      .from('v_user_unread_count')
      .select('unread_count')
      .eq('user_id', userId)
      .maybeSingle()
    if (error) {
      // Table may not exist yet — soft-fail
      if (!/relation .* does not exist/i.test(error.message)) {
        console.warn('[notifications] unread count query failed:', error.message)
      }
      return
    }
    const n = data?.unread_count ?? 0
    setCount(n)
    if (lastSetRef.current !== n) {
      lastSetRef.current = n
      Notifications.setBadgeCountAsync(n).catch(() => {
        // Permission denied or platform doesn't support — ignore
      })
    }
  }, [userId])

  useEffect(() => {
    if (!userId) return
    refresh()
    const ch = supabase
      .channel(chanName(`notifications:${userId}`))
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          // Debounce-friendly: just re-query the view, cheaper than
          // maintaining a local mirror of the table.
          refresh()
        },
      )
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
    }
  }, [userId, refresh])

  return count
}

/**
 * Loads the notification feed (most recent N) + subscribes for live
 * updates. Returns the rows and a refresh function.
 */
export function useNotificationFeed(
  userId: string | undefined | null,
  limit = 50,
): {
  rows: NotificationRow[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
} {
  const [rows, setRows] = useState<NotificationRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!userId) return
    setError(null)
    const { data, error: err } = await supabase
      .from('notifications')
      .select('id, user_id, kind, deal_id, thread_id, title, body, data, created_at, read_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (err) {
      if (/relation .* does not exist/i.test(err.message)) {
        // Migration hasn't been applied — show empty state silently
        setRows([])
      } else {
        setError(err.message)
      }
    } else {
      setRows((data ?? []) as NotificationRow[])
    }
    setLoading(false)
  }, [userId, limit])

  useEffect(() => {
    if (!userId) return
    refresh()
    const ch = supabase
      .channel(chanName(`notifications-feed:${userId}`))
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          refresh()
        },
      )
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
    }
  }, [userId, refresh])

  return { rows, loading, error, refresh }
}

/** Mark one notification read. Fire-and-forget. */
export async function markRead(notificationId: string): Promise<void> {
  const { error } = await supabase.rpc('mark_notification_read', {
    p_notification_id: notificationId,
  })
  if (error && !/function .* does not exist/i.test(error.message)) {
    console.warn('[notifications] mark_read failed:', error.message)
  }
}

/** Mark all the caller's unread as read. Returns count cleared. */
export async function markAllRead(): Promise<number> {
  const { data, error } = await supabase.rpc('mark_all_read')
  if (error) {
    if (!/function .* does not exist/i.test(error.message)) {
      console.warn('[notifications] mark_all_read failed:', error.message)
    }
    return 0
  }
  // Reset the OS badge eagerly — the realtime sub will reconcile if drift
  Notifications.setBadgeCountAsync(0).catch(() => {})
  return typeof data === 'number' ? data : 0
}

/** Mark all unread for a given deal as read. */
export async function markDealRead(dealId: string): Promise<number> {
  const { data, error } = await supabase.rpc('mark_deal_read', {
    p_deal_id: dealId,
  })
  if (error && !/function .* does not exist/i.test(error.message)) {
    console.warn('[notifications] mark_deal_read failed:', error.message)
  }
  return typeof data === 'number' ? data : 0
}

/** Mark all unread for a given team thread as read. */
export async function markThreadRead(threadId: string): Promise<number> {
  const { data, error } = await supabase.rpc('mark_thread_read', {
    p_thread_id: threadId,
  })
  if (error && !/function .* does not exist/i.test(error.message)) {
    console.warn('[notifications] mark_thread_read failed:', error.message)
  }
  return typeof data === 'number' ? data : 0
}

/**
 * Hook for per-deal unread counts on the deals list. Returns a record
 * keyed by deal_id. Refreshed on realtime + on demand.
 */
export function useDealUnreadCounts(
  userId: string | undefined | null,
): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({})

  const refresh = useCallback(async () => {
    if (!userId) return
    const { data, error } = await supabase
      .from('v_deal_unread_for_user')
      .select('deal_id, unread_count')
      .eq('user_id', userId)
    if (error) {
      if (!/relation .* does not exist/i.test(error.message)) {
        console.warn('[notifications] deal unread query failed:', error.message)
      }
      return
    }
    const next: Record<string, number> = {}
    for (const row of (data ?? []) as Array<{ deal_id: string; unread_count: number }>) {
      if (row.deal_id) next[row.deal_id] = row.unread_count
    }
    setCounts(next)
  }, [userId])

  useEffect(() => {
    if (!userId) return
    refresh()
    const ch = supabase
      .channel(chanName(`deal-unread:${userId}`))
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        () => refresh(),
      )
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
    }
  }, [userId, refresh])

  return counts
}

/**
 * Count of unread team_message notifications. Used for the Team tab badge.
 */
export function useTeamUnreadCount(userId: string | undefined | null): number {
  const [count, setCount] = useState(0)
  const refresh = useCallback(async () => {
    if (!userId) return
    const { count: n, error } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('kind', 'team_message')
      .is('read_at', null)
    if (error) {
      if (!/relation .* does not exist/i.test(error.message)) {
        console.warn('[notifications] team unread count failed:', error.message)
      }
      return
    }
    setCount(n ?? 0)
  }, [userId])
  useEffect(() => {
    if (!userId) return
    refresh()
    const ch = supabase
      .channel(chanName(`team-unread:${userId}`))
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        () => refresh(),
      )
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
    }
  }, [userId, refresh])
  return count
}
