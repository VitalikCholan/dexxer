// Dark-only by design — see use-color-scheme.ts. No hydration dance needed
// here since the value never depends on the system scheme or the client.
export const useColorScheme = () => 'dark' as const
