import React from 'react'
import { ScrollView, Text } from 'react-native'
import { AppPage } from '@/components/app-page'
import { Check8 } from '@/src/spikes/Check8'
import { Check10 } from '@/src/spikes/Check10'
import { Check11 } from '@/src/spikes/Check11'

export default function TabsSpikesScreen() {
  return (
    <AppPage>
      <ScrollView contentContainerStyle={{ gap: 24, paddingVertical: 16 }}>
        <Text style={{ fontSize: 20, fontWeight: '700' }}>Week-0 mobile checks</Text>
        <Check8 />
        <Check10 />
        <Check11 />
      </ScrollView>
    </AppPage>
  )
}
