import { PortalHost } from '@rn-primitives/portal'
import { useFonts } from 'expo-font'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import 'react-native-reanimated'
import { AppProviders } from '@/src/shell/AppProviders'
import { useCallback } from 'react'
import * as SplashScreen from 'expo-splash-screen'
import { View } from 'react-native'
import { useTrackLocations } from '@/hooks/use-track-locations'
import { AppSplashController } from '@/src/shell/AppSplashController'
import { useAuth } from '@/src/shell/AuthProvider'
import { ThemeProvider, colors } from '@/src/theme'
import { ToastHost } from '@/src/ui/Toast'
import { flushPendingCrash, installCrashReporter, setCurrentScreen } from '@/src/lib/crashReporter'
import { record } from '@/src/lib/diagnostics'

SplashScreen.preventAutoHideAsync()
// Closed beta: catch JS crashes from the very start, and send the one the
// previous run left behind (lib/crashReporter.ts).
installCrashReporter()
void flushPendingCrash()

export default function RootLayout() {
  // Use this hook to track the locations for analytics or debugging.
  // Delete if you don't need it.
  // Navigation goes into the diagnostics log (paths only — never params), and
  // the current screen into crash and bug reports.
  useTrackLocations((pathname) => {
    if (__DEV__) console.log(`Track ${pathname}`)
    record('info', 'nav', pathname)
    if (pathname !== '/report') setCurrentScreen(pathname)
  })
  const [loaded] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
  })

  const onLayoutRootView = useCallback(async () => {
    console.log('onLayoutRootView')
    if (loaded) {
      console.log('loaded')
      // This tells the splash screen to hide immediately! If we call this after
      // `setAppIsReady`, then we may see a blank screen while the app is
      // loading its initial state and rendering its first pixels. So instead,
      // we hide the splash screen once we know the root view has already
      // performed layout.
      await SplashScreen.hideAsync()
    }
  }, [loaded])

  if (!loaded) {
    // Async font loading only occurs in development.
    return null
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} onLayout={onLayoutRootView}>
      <ThemeProvider>
        <AppProviders>
          <AppSplashController />
          <RootNavigator />
          <StatusBar style="auto" />
        </AppProviders>
        <ToastHost />
      </ThemeProvider>
      <PortalHost />
    </View>
  )
}

function RootNavigator() {
  const { isAuthenticated } = useAuth()
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={isAuthenticated}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="markets" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="+not-found" />
      </Stack.Protected>
      <Stack.Protected guard={!isAuthenticated}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      {/* Closed beta: reachable whether or not a wallet is connected. */}
      <Stack.Screen name="report" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
    </Stack>
  )
}
