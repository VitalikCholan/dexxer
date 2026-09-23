// app/app/(tabs)/ledger.tsx
//
// Placeholder for the week-4 Task 10 ledger tab — real content lands there.
// For now this just proves the route/tab exists.
import { AppPage } from '@/components/app-page'
import { EmptyState } from '@/src/ui/EmptyState'

export default function TabsLedgerScreen() {
  return (
    <AppPage>
      <EmptyState text="No ledger entries yet." />
    </AppPage>
  )
}
