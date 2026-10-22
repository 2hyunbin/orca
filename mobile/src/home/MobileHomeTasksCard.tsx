import { ListTodo } from 'lucide-react-native'
import { Pressable, StyleSheet, View } from 'react-native'
import { TaskProviderLogo } from '../components/TaskProviderLogo'
import { ListRow } from '../components/ui/ListRow'
import { pressTransition } from '../components/ui/transition-styles'
import type { TaskProvider } from '../../../src/shared/task-providers'
import { colors, MIN_TOUCH_TARGET, motion } from '../theme/mobile-theme'

const TASK_PROVIDER_LABELS: Record<TaskProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  linear: 'Linear',
  jira: 'Jira'
}

/** The Tasks row of Home's Actions group, with a shortcut per source when there are several. */
export function MobileHomeTasksCard(props: {
  enabled: boolean
  providers: TaskProvider[]
  onOpen: (provider?: TaskProvider) => void
}) {
  const names = props.providers.map((provider) => TASK_PROVIDER_LABELS[provider]).join(' · ')
  return (
    <ListRow
      title="Tasks"
      subtitle={props.enabled ? names || 'GitHub' : 'Connect a desktop first.'}
      leading={<ListTodo size={20} color={colors.textSecondary} strokeWidth={2} />}
      navigates
      disabled={!props.enabled}
      onPress={() => props.onOpen()}
      accessibilityLabel={props.enabled ? `Tasks, ${names}` : 'Tasks, connect a desktop first'}
      accessory={
        props.enabled && props.providers.length > 1 ? (
          <View style={styles.providers}>
            {props.providers.map((provider) => (
              <Pressable
                key={provider}
                accessibilityRole="button"
                accessibilityLabel={`Open ${TASK_PROVIDER_LABELS[provider]} tasks`}
                style={styles.providerTouch}
                onPress={(event) => {
                  event.stopPropagation()
                  props.onOpen(provider)
                }}
              >
                {({ pressed }) => (
                  <View
                    style={[
                      styles.providerCircle,
                      pressed && styles.providerPressed,
                      pressed ? pressTransition.pressed : pressTransition.rest
                    ]}
                  >
                    <TaskProviderLogo provider={provider} size={16} color={colors.textPrimary} />
                  </View>
                )}
              </Pressable>
            ))}
          </View>
        ) : undefined
      }
    />
  )
}

const CIRCLE = 32

const styles = StyleSheet.create({
  providers: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
  providerTouch: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center'
  },
  providerCircle: {
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  providerPressed: {
    backgroundColor: colors.fillPressed,
    transform: [{ scale: motion.pressedIconScale }]
  }
})
