/** Thrown by every call; `winCode` is the Win32 error the named API returned. */
export type WindowsSecurityError = Error & { winCode: number; syscall: string }

export type GrantAccessOptions = {
  /** Children inherit the grant (OI|CI). Only meaningful on a directory. */
  inheritable: boolean
  /** Replace the trustee's existing explicit allow rules (`icacls /grant:r`) instead of merging. */
  replace: boolean
}

/** The process token's user SID, e.g. `S-1-5-21-…-1001`. */
export declare function currentUserSid(): string

/** The path's DACL as SDDL (`D:…`), aliases and all. */
export declare function getDaclSddl(path: string): string

/**
 * Installs exactly the DACL in `sddl`. Its `P` flag picks protected or inheriting. A directory
 * propagates to every existing descendant, which is seconds on a large tree.
 */
export declare function setDaclSddl(path: string, sddl: string): void
export declare function setDaclSddlAsync(path: string, sddl: string): Promise<void>

/** Creates a NEW file already carrying the DACL in `sddl`, then writes `data` into it. */
export declare function createFileWithDacl(path: string, sddl: string, data: Uint8Array): void

/** Adds an allow rule for `sid` to the existing DACL, keeping its protection state. */
export declare function grantAccess(
  path: string,
  sid: string,
  accessMask: number,
  options: GrantAccessOptions
): void
export declare function grantAccessAsync(
  path: string,
  sid: string,
  accessMask: number,
  options: GrantAccessOptions
): Promise<void>
