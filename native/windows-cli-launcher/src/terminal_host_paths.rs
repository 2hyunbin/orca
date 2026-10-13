use std::ffi::{c_void, OsString};
use std::os::windows::ffi::OsStringExt;
use std::path::{Component, Path, PathBuf};

#[repr(C)]
struct Guid(u32, u16, u16, [u8; 8]);

// FOLDERID_LocalAppData
const LOCAL_APP_DATA: Guid = Guid(
    0xF1B3_2785,
    0x6FBA,
    0x4FCF,
    [0x9D, 0x55, 0x7B, 0x8E, 0x7F, 0x15, 0x70, 0x91],
);

#[link(name = "shell32")]
extern "system" {
    fn SHGetKnownFolderPath(
        id: *const Guid,
        flags: u32,
        token: *mut c_void,
        path: *mut *mut u16,
    ) -> i32;
}

#[link(name = "ole32")]
extern "system" {
    fn CoTaskMemFree(memory: *mut c_void);
}

pub struct TrustedHost {
    pub program: PathBuf,
    pub entry: PathBuf,
}

fn installation_root(launcher: &Path) -> Option<&Path> {
    let directory = launcher.parent()?;
    let parent = directory.parent()?;
    let root = parent.parent()?;
    // The dev launcher has one extra directory compared with resources\bin\orca.exe.
    if directory.file_name() == Some(std::ffi::OsStr::new(".build"))
        && parent.file_name() == Some(std::ffi::OsStr::new("windows-cli-launcher"))
        && root.file_name() == Some(std::ffi::OsStr::new("native"))
    {
        root.parent()
    } else {
        Some(root)
    }
}

// Read from the shell, not %LOCALAPPDATA%: the unelevated caller controls the environment.
fn local_app_data() -> Option<PathBuf> {
    let mut raw = std::ptr::null_mut();
    // SAFETY: on success the shell allocates a NUL-terminated string this function frees.
    unsafe {
        if SHGetKnownFolderPath(&LOCAL_APP_DATA, 0, std::ptr::null_mut(), &mut raw) != 0 {
            CoTaskMemFree(raw as *mut c_void);
            return None;
        }
        let mut length = 0;
        while *raw.add(length) != 0 {
            length += 1;
        }
        let path = OsString::from_wide(std::slice::from_raw_parts(raw, length));
        CoTaskMemFree(raw as *mut c_void);
        Some(PathBuf::from(path))
    }
}

/// The elevated host must be Orca's own runtime: the install (or dev checkout) that holds this
/// launcher, or this account's relocated daemon-host copy. Otherwise Orca's consent prompt
/// would elevate whatever program another unelevated process names.
pub fn trusted_host(launcher: &Path, program: &Path, entry: &Path) -> Option<TrustedHost> {
    let program = std::fs::canonicalize(program).ok()?;
    let entry = std::fs::canonicalize(entry).ok()?;
    if !program.is_file() || !entry.is_file() {
        return None;
    }
    // <install>\resources\bin\orca.exe and <repo>\native\windows-cli-launcher\.build\orca.exe
    let install = std::fs::canonicalize(installation_root(launcher)?).ok()?;
    let relocated = local_app_data().and_then(|root| {
        std::fs::canonicalize(root.join("Orca").join("daemon-host-profiles")).ok()
    });
    let trusted = |root: &Path| program.starts_with(root) && entry.starts_with(root);
    if trusted(&install) {
        return Some(TrustedHost { program, entry });
    }
    // <profiles>\<profile>\<version>\<build>\...: both files must sit in one relocated build.
    let build = relocated.and_then(|root| {
        let relative = program.strip_prefix(&root).ok()?;
        let mut parts = relative.components();
        let build: PathBuf = [parts.next()?, parts.next()?, parts.next()?]
            .iter()
            .collect();
        parts.next()?;
        Some(root.join(build))
    })?;
    trusted(&build).then_some(TrustedHost { program, entry })
}

/// Daemon file arguments may only name paths under the profile the caller asked to serve.
pub fn is_inside(root: &Path, path: &Path) -> bool {
    path.is_absolute()
        && path.starts_with(root)
        && !path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_packaged_and_development_installations() {
        for (launcher, root) in [
            (
                r"C:\Program Files\Orca\resources\bin\orca.exe",
                r"C:\Program Files\Orca",
            ),
            (
                r"C:\repo 雪\native\windows-cli-launcher\.build\orca.exe",
                r"C:\repo 雪",
            ),
        ] {
            assert_eq!(
                installation_root(Path::new(launcher)),
                Some(Path::new(root))
            );
        }
    }

    #[test]
    fn rejects_paths_escaping_user_data() {
        let root = Path::new(r"C:\Users\a\AppData\Roaming\orca");
        assert!(is_inside(root, &root.join(r"daemon-admin\token")));
        assert!(!is_inside(root, &root.join(r"..\..\evil")));
        assert!(!is_inside(
            root,
            Path::new(r"C:\Windows\System32\drivers\etc\hosts")
        ));
        assert!(!is_inside(root, Path::new(r"daemon-admin\token")));
    }
}
