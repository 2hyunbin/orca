// Share marker normalization with desktop so rendering and echo reconciliation agree on image turns.
export {
  imageSourcePathFromText,
  hasImagePromptMarker,
  isImageSourceUserTurn,
  normalizeImageTranscriptMessages,
  normalizeNativeChatUserText,
  normalizedNativeChatUserMessageText,
  stripImagePromptMarker
} from '../../../src/shared/native-chat-image-transcript-markers'
