// app/src/features/ledger/LedgerScreen.tsx
//
// Task 10: the public ledger — "what the world sees" (design §4, the pitch
// showcase for the app's privacy model). Works with no wallet connected: all
// three tabs read the relayer's public indexer (`indexer.ts`, Task 9), never
// a permissioned owner/session account.
import { useState } from 'react'
import { Page } from '@/src/ui/Page'
import { Segment } from '@/src/ui/Segment'
import { DisclosuresTab } from './DisclosuresTab'
import { PoolTab } from './PoolTab'
import { RootTab } from './RootTab'

type LedgerTab = 'disclosures' | 'pool' | 'root'

export function LedgerScreen() {
  const [tab, setTab] = useState<LedgerTab>('disclosures')

  return (
    <Page>
      <Segment
        value={tab}
        onChange={setTab}
        options={[
          { value: 'disclosures', label: 'Disclosures' },
          { value: 'pool', label: 'Pool' },
          { value: 'root', label: 'Root' },
        ]}
      />
      {tab === 'disclosures' ? <DisclosuresTab /> : tab === 'pool' ? <PoolTab /> : <RootTab />}
    </Page>
  )
}
