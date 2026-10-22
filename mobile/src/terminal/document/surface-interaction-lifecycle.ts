import type { TerminalDocumentScope } from './document-scope'
import { stopSurfaceTouchGestures } from './surface-touch-gestures'
import { resetSmoothScrollOffset } from './normal-buffer-smooth-scroll'
import { clearLongPress } from './tap-dispatch'
import { stopEdgeScroll } from './selection-overlay'
import { updateTransform } from './viewport-transform'
import { emitKeyboardAvoidanceMetrics } from './keyboard-avoidance-metrics'

export function suspendSurfaceTouchGestures(scope: TerminalDocumentScope) {
  const interruptedPinch = scope.touchGesture.isPinching
  stopSurfaceTouchGestures(scope)
  resetSmoothScrollOffset(scope)
  if (interruptedPinch) {
    scope.userScale = 1
    scope.panX = 0
    scope.panY = 0
    if (scope.surface) {
      updateTransform(scope)
    }
    emitKeyboardAvoidanceMetrics(scope)
  }
  clearLongPress(scope)
  stopEdgeScroll(scope)
  scope.tapCandidate = null
  scope.mouseGesture = null
  scope.wheelAccumDeltaY = 0
  scope.touchGesture.velY = 0
  scope.touchGesture.accumDelta = 0
  scope.touchGesture.isPinching = false
  scope.touchDispatch = {
    mode: 'idle',
    touchId: null,
    touchIds: null,
    longPressFingerInsideOverlay: false
  }
  if (scope.sel) {
    scope.sel.activeHandle = null
  }
}
