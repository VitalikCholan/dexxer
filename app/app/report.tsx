import { BugReportScreen } from '@/src/features/feedback/BugReportScreen'

// Closed beta: reachable with or without a connected wallet (declared outside
// both `Stack.Protected` groups in `_layout.tsx`).
export default function ReportRoute() {
  return <BugReportScreen />
}
