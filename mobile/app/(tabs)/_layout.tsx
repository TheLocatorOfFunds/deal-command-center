/**
 * Tab navigator for the authenticated app. v1 ships with just Today;
 * Deals + Comms will land as siblings once the v1 scope is finalized
 * with Nathan.
 */

import { Tabs } from 'expo-router'

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: '#0c0a09' },
        headerTitleStyle: { color: '#fafaf9' },
        tabBarStyle: { backgroundColor: '#0c0a09', borderTopColor: '#1c1917' },
        tabBarActiveTintColor: '#d97706',
        tabBarInactiveTintColor: '#78716c',
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Today',
          tabBarLabel: '📌 Today',
        }}
      />
    </Tabs>
  )
}
