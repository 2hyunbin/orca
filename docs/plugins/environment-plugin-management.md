# Plugin catalogs on control hosts

A provider's catalog, installed release, approval, account, credentials, and inventory belong to its control host. Choosing another host must never fall back to the desktop catalog.

The catalog backend reuses the desktop marketplace and install services. Its paired runtime method, `plugins.management.call`, accepts a fixed set of catalog, install, approval, enablement, log, and plugin preference operations. It cannot invoke plugin commands, open panels, write arbitrary settings, inject consent fingerprints through settings, or choose another host inside an operation. The host advertises `plugins.management.v1` only when this controller is composed.

Every remote request requires a host-admin runtime pairing, a live connection, negotiated support, and the exact runtime instance the user reviewed. The native review additionally captures the saved environment and pairing revision, transport generation, and owning window. Navigation, disconnect, replacement pairing, or a changed server retires it. A retired connection cannot reconnect and replay an installation or approval.

Installation remains separate from executable approval. Data-only release installation uses the existing validated data path; executable or instructional changes require the existing release review. Approval checks the live owner again immediately before writing consent, after asynchronous content verification or staging. Shutdown closes admissions and drains accepted catalog operations and official-source metadata writes before the profile is frozen.

An accepted install or source refresh can finish on its original host after the reviewer disconnects. It is not replayed on another host. Git work currently uses the existing transfer limits and has no per-review abort signal; stronger transfer bounds remain a release gate. Approval cannot be granted by the disconnected review.

The backend and native bridge are implemented before the catalog renderer. Until the renderer is connected and validated, the existing remote provider “Browse plugins” route remains a known release gap. Remote SSH target composition and end-to-end SSH connection proof are separate remaining gates. Do not interpret catalog management support as a claim that a Node control host already supports every ordinary SSH method.
