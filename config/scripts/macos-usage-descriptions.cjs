const { MACOS_FOLDER_USAGE_DESCRIPTIONS } = require('./macos-folder-usage-descriptions.cjs')
// Shared with the terminal host helper so its purpose strings cannot drift from the app's.
const MAC_USAGE_DESCRIPTIONS = {
  NSAppleEventsUsageDescription:
    'Orca allows terminal-launched developer tools to automate local apps when you request it.',
  NSBluetoothAlwaysUsageDescription:
    'Orca allows terminal-launched developer tools to access Bluetooth devices when you request it.',
  NSBluetoothPeripheralUsageDescription:
    'Orca allows terminal-launched developer tools to access Bluetooth devices when you request it.',
  NSCameraUsageDescription: "Application requests access to the device's camera.",
  NSLocationUsageDescription:
    'Orca allows terminal-launched developer tools to access location when you request it.',
  NSLocalNetworkUsageDescription:
    'Orca allows terminal-launched developer tools to discover and connect to local development servers when you request it.',
  NSMicrophoneUsageDescription: "Application requests access to the device's microphone.",
  NSAudioCaptureUsageDescription:
    'Orca allows terminal-launched developer tools to capture desktop audio when you request it.',
  NSBonjourServices: ['_http._tcp', '_https._tcp'],
  ...MACOS_FOLDER_USAGE_DESCRIPTIONS
}
module.exports = { MAC_USAGE_DESCRIPTIONS }
