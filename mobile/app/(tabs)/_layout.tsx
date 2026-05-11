/**
 * Tab navigator — 4 bottom tabs based on the IA synthesis from research
 * across LeadConnector, HubSpot, Pipedrive, Salesforce, Close, and
 * Twilio Frontline (see memory/mobile_app_plan.md).
 *
 *   Inbox · Deals · Lauren · Team
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

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#0c0a09',
          borderTopColor: '#1c1917',
          borderTopWidth: 1,
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
        }}
      />
      <Tabs.Screen
        name="deals"
        options={{
          title: 'Deals',
          tabBarLabel: 'Deals',
        }}
      />
      <Tabs.Screen
        name="lauren"
        options={{
          title: 'Lauren',
          tabBarLabel: 'Lauren',
        }}
      />
      <Tabs.Screen
        name="team"
        options={{
          title: 'Team',
          tabBarLabel: 'Team',
        }}
      />
    </Tabs>
  )
}
