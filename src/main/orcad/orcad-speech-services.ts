import { ModelManager } from '../speech/model-manager'
import { openNodeSpeechDownloadRequest } from '../speech/node-speech-download-request'
import type { SpeechServiceFactories } from '../speech/speech-runtime-service'
import { SttService } from '../speech/stt-service'

/**
 * orcad's speech (#31174): cloud models always, on-device models when `orca serve` hands it the
 * installed app's recognizer. Models land in this profile's `speech-models`, as on Electron serve.
 */
export const orcadSpeechServiceFactories: SpeechServiceFactories = {
  createModelManager: (customModelsDir) =>
    new ModelManager(customModelsDir, openNodeSpeechDownloadRequest),
  createSttService: (models) => new SttService(models)
}
