import type { OrcaRuntimeWithRegisterPty } from '../../orca-runtime-register-pty'

export type PtyRegistrationBinding = NonNullable<
  Parameters<OrcaRuntimeWithRegisterPty['registerPty']>[3]
>
