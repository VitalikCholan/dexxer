import { router } from 'expo-router'
import { useState } from 'react'
import { useAuth } from '@/src/shell/AuthProvider'
import { ConnectScreen } from '@/src/features/onboard/ConnectScreen'
import { showError } from '@/utils/show-error'

// Root gate's screen (`app/_layout.tsx`'s `Stack.Protected`): shown while
// no wallet account is authorized. Week 6: renders the product
// `ConnectScreen` (Dexxer branding, `src/ui` tokens) instead of the
// template's "app" + placeholder icon — one connect UI for gate and
// onboarding. The gate itself (wallet-ui `accounts.length > 0`) is unchanged.
export default function SignIn() {
  const { signIn } = useAuth()
  const [isSigningIn, setIsSigningIn] = useState(false)

  // Sign-in goes through the wallet, which can decline or fail the request.
  async function handleSignIn() {
    if (isSigningIn) return
    setIsSigningIn(true)
    try {
      await signIn()
      // We only get here when sign-in succeeded, so it is safe to navigate.
      router.replace('/')
    } catch (error) {
      showError('Could not sign in', error)
    } finally {
      setIsSigningIn(false)
    }
  }

  return (
    <ConnectScreen busy={isSigningIn} onConnect={() => void handleSignIn()} onReport={() => router.push('/report')} />
  )
}
