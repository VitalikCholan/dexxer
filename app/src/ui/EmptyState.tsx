// app/src/ui/EmptyState.tsx
import { Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { Button } from './Button'
import { useTextStyle } from './styles'

export interface EmptyStateAction {
  label: string
  onPress: () => void
}

export interface EmptyStateProps {
  text: string
  action?: EmptyStateAction
}

export function EmptyState({ text, action }: EmptyStateProps) {
  const { colors, space } = useTheme()
  const textStyle = useTextStyle('body')

  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl }}>
      <Text style={[textStyle, { color: colors.textSecondary, textAlign: 'center' }]}>{text}</Text>
      {action ? (
        <Button variant="secondary" onPress={action.onPress}>
          {action.label}
        </Button>
      ) : null}
    </View>
  )
}
