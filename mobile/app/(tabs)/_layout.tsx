/**
 * Tab navigator — 4 bottom tabs based on the IA synthesis from research
 * across LeadConnector, HubSpot, Pipedrive, Salesforce, Close, and
 * Twilio Frontline (see memory/mobile_app_plan.md).
 *
 *   Inbox · Leads · Lauren · Team
 *
 * "Leads" replaces the earlier "Deals" label per #290 (2026-06-08) — the
 * tab holds both pre-contract leads AND under-contract deals AND closed
 * deals AND deleted leads. "Deals" was misleading because it implied
 * only the under-contract subset. See LABELS.md for the canonical UI
 * label mapping that BOTH web and mobile follow.
 *
 * The center "⊕ Quick" FAB is intentionally NOT a tab yet — adding it
 * means a custom tabBarButton override, which we'll land as a follow-up
 * once Inbox and the thread view are proven.
 *
 * Inbox is leftmost (default) because the app is comms-led. Calling
 * deliberately has no tab — it lives as a sticky header action on the
 * Deal Detail screen, matching every CRM mobile app surveyed.
 */

import { Tabs } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { QuickFabButton } from '../../components/QuickFabButton'
import { useAuth } from '../../lib/auth'
import { useTeamUnreadCount } from '../../lib/notifications'

type IoniconName = React.ComponentProps<typeof Ionicons>['name']

// Icon renderer factory — keeps the tab declarations readable.
const icon =
  (name: IoniconName) =>
  ({ color, size }: { color: string; size: number }) => (
    <Ionicons name={name} color={color} size={size} />
  )

export default function TabsLayout() {
  const { session } = useAuth()
  const teamUnread = useTeamUnreadCount(session?.user?.id ?? null)
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#0c0a09',
          borderTopColor: '#1c1917',
          borderTopWidth: 1,
          height: 78,
          paddingTop: 6,
        },
        tabBarActiveTintColor: '#d97706',
        tabBarInactiveTintColor: '#78716c',
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Inbox',
          tabBarLabel: 'Inbox',
          tabBarIcon: icon('chatbubbles'),
        }}
      />
      <Tabs.Screen
        name="deals"
        options={{
          // Tab label is "Leads" per #290 (IA rename 2026-06-08). The file
          // is still deals.tsx and the route is /deals — renaming the route
          // would break deep-links from notifications. UI label only.
          title: 'Leads',
          tabBarLabel: 'Leads',
          tabBarIcon: icon('briefcase'),
        }}
      />
      {/* Center "⊕ Quick" — not a route, just a button that opens a sheet. */}
      <Tabs.Screen
        name="quick"
        options={{
          title: 'Quick',
          tabBarLabel: () => null,
          tabBarIcon: () => null,
          tabBarButton: () => <QuickFabButton />,
        }}
      />
      <Tabs.Screen
        name="lauren"
        options={{
          title: 'Lauren',
          tabBarLabel: 'Lauren',
          tabBarIcon: icon('sparkles'),
        }}
      />
      <Tabs.Screen
        name="team"
        options={{
          title: 'Team',
          tabBarLabel: 'Team',
          tabBarIcon: icon('people'),
          tabBarBadge: teamUnread > 0 ? (teamUnread > 9 ? '9+' : teamUnread) : undefined,
          tabBarBadgeStyle: {
            backgroundColor: '#d97706',
            color: '#0c0a09',
            fontSize: 10,
            fontWeight: '700',
          },
        }}
      />
    </Tabs>
  )
}
