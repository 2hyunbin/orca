import type { DeviceEntry } from '../device-registry'
import { devicePrincipalOf } from '../device-principal'
import type { E2EEAuthenticatedDevice } from './e2ee-channel'

export function toAuthenticatedDevice(device: DeviceEntry): E2EEAuthenticatedDevice {
  return {
    ...devicePrincipalOf(device),
    ...(device.token !== undefined ? { deviceToken: device.token } : {})
  }
}
