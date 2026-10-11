import { defineMethod } from '../core'

// `automaticWork: null` means the local terminal owner has no fork gate to report or resume.
export const AUTOMATIC_WORK_METHODS = [
  defineMethod({
    name: 'runtime.automaticWork.status',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => ({
      automaticWork: await runtime.getAutomaticWorkStatus()
    })
  }),
  defineMethod({
    name: 'runtime.automaticWork.resume',
    permission: 'host-admin',
    params: null,
    handler: async (_params, { runtime }) => ({
      automaticWork: await runtime.resumeAutomaticWork()
    })
  })
]
