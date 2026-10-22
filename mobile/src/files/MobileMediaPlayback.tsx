import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { CircleAlert } from 'lucide-react-native'
import { StateView } from '../components/ui/StateView'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'

export type MobileMediaPlaybackProps = { uri: string; mimeType: string; title: string }

export function MobileMediaPlayback({ uri, mimeType, title }: MobileMediaPlaybackProps) {
  const mediaRef = useRef<HTMLMediaElement>(null)
  const [failure, setFailure] = useState('')
  useEffect(() => {
    const blockedMedia = (event: SecurityPolicyViolationEvent): void => {
      if (event.effectiveDirective === 'media-src') {
        setFailure('Update Orca Mobile to play media in this workspace.')
      }
    }
    document.addEventListener('securitypolicyviolation', blockedMedia)
    const media = mediaRef.current
    if (media) {
      media.src = uri
    }
    return () => {
      document.removeEventListener('securitypolicyviolation', blockedMedia)
      if (media) {
        media.pause()
        media.removeAttribute('src')
        media.load()
      }
    }
  }, [uri])
  if (failure) {
    return <StateView icon={CircleAlert} title="Can’t play this file" message={failure} />
  }
  const props = {
    src: uri,
    controls: true,
    preload: 'metadata',
    'aria-label': title,
    ref: (element: HTMLMediaElement | null): void => {
      mediaRef.current = element
    },
    onError: (): void =>
      setFailure((current) => current || 'Its format may not be supported on this device.')
  }
  return (
    <View style={styles.state}>
      {mimeType.startsWith('audio/') ? (
        <audio {...props} style={{ width: '100%' }} />
      ) : (
        <video {...props} playsInline style={{ width: '100%', maxHeight: '100%' }} />
      )}
    </View>
  )
}
