# How the headless server stores credentials

The desktop app seals saved credentials (Linear, Jira, Bitbucket, API keys) with Electron's
`safeStorage`, which uses the OS keychain. The headless server (`orcad`, the managed SSH server)
has no Electron, so it seals them itself, on the machine it runs on
(`src/main/orcad/orcad-secret-store.ts`).

## Where the key lives

Each credential is encrypted with AES-256-GCM. The master key is created on first start and
stored in one of two places. The choice is recorded in `orcad-secret-store.json` in the server's
profile directory (`$ORCA_USER_DATA`, `$XDG_DATA_HOME/Orca`, or `~/.orca`):

| Host | Where the key goes |
| --- | --- |
| macOS | The login Keychain (through `/usr/bin/security`) if the server can reach it on first start |
| Linux | The Secret Service keyring (`secret-tool`) if the session has a D-Bus session bus and a keyring answers |
| Otherwise, and on Windows | `orcad-secret-store.json` itself, mode `0600` (an owner-only ACL on Windows), mixed with the machine ID (`/etc/machine-id`, macOS hardware UUID, Windows `MachineGuid`) |

Windows does not use DPAPI. Reaching it from Node takes PowerShell or a native addon, and running
PowerShell for each operation is an EDR signal.

## Limitations

- **The profile key file is weaker than a keychain.** It means a credential file, or a copy of the
  profile taken to another machine, can't be read. It does not stop anyone who can already read
  this account's files on this host. The server logs this gap once with the `[secrets]` prefix.
  A keychain does not protect against other processes running as the same unlocked user either.
- **The key belongs to the host.** If the recorded keyring is locked or can't be reached, or the
  machine ID changes, the server does not fall back to plaintext. It leaves the saved credentials
  alone and refuses new saves until the key loads again. If the key is gone for good, deleting
  `orcad-secret-store.json` starts over, and every integration has to be connected again.
- **Shared home directories.** Integration credentials live in `~/.orca` under the login home.
  Hosts that share that home (over NFS, for example), or a desktop app on the same machine, each
  seal with their own key, so a credential one of them saves can't be read by the others. To keep
  the old shared plaintext behavior on such hosts, set `ORCA_HEADLESS_SECRET_STORE=plaintext`.
- **GitHub and GitLab** tokens are not stored by Orca at all. `gh` and `glab` keep them, under
  their own storage settings.

## Migration

On startup, once the key loads, the server seals every credential that an older version stored in
plaintext. Each file is rewritten only after the new value has been decrypted and checked, and
only if no other process changed the file in the meantime. A file that can't be sealed is left as
it was. Readers still accept the legacy plaintext form, so no credential is lost.
