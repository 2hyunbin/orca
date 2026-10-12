use std::env;
use std::ffi::{c_void, OsStr, OsString};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::exit;
use std::time::{Duration, Instant};

use crate::terminal_host_process::TerminalHostProcess;
use crate::terminal_host_security::{allow_medium_integrity_client, is_elevated};

const REQUEST: &str = "--orca-admin-terminal-host";
const APPROVED: &str = "--orca-approved-terminal-host";

#[repr(C)]
struct ShellExecuteInfo {
    size: u32,
    mask: u32,
    window: *mut c_void,
    verb: *const u16,
    file: *const u16,
    parameters: *const u16,
    directory: *const u16,
    show: i32,
    instance: *mut c_void,
    id_list: *mut c_void,
    class: *const u16,
    class_key: *mut c_void,
    hot_key: u32,
    icon: *mut c_void,
    process: *mut c_void,
}

#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteExW(info: *mut ShellExecuteInfo) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
    fn GetExitCodeProcess(handle: *mut c_void, code: *mut u32) -> i32;
    fn CloseHandle(handle: *mut c_void) -> i32;
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

// ShellExecute takes one command line; apply the same backslash rules as CommandLineToArgvW.
pub(crate) fn quote(value: &OsStr) -> Vec<u16> {
    let mut result = vec![34];
    let mut slashes = 0;
    for unit in value.encode_wide() {
        if unit == 92 {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat(92).take(if unit == 34 {
            slashes * 2 + 1
        } else {
            slashes
        }));
        result.push(unit);
        slashes = 0;
    }
    result.extend(std::iter::repeat(92).take(slashes * 2));
    result.push(34);
    result
}

pub fn run_if_requested(launcher: &Path) {
    let args: Vec<OsString> = env::args_os().skip(1).collect();
    let Some(mode) = args.first() else { return };
    if mode == "--orca-check-administrator" {
        println!("{{\"elevated\":{}}}", is_elevated());
        exit(0);
    }
    if mode != REQUEST && mode != APPROVED {
        return;
    }
    if args.len() < 6 {
        crate::fail("Missing administrator terminal host launch arguments");
    }
    if mode == REQUEST && !is_elevated() {
        let file = wide(launcher.as_os_str());
        let verb = wide(OsStr::new("runas"));
        let mut parameters = quote(OsStr::new(APPROVED));
        for arg in &args[1..] {
            parameters.push(32);
            parameters.extend(quote(arg));
        }
        parameters.push(0);
        // SAFETY: zero is valid for all unused SHELLEXECUTEINFOW fields; buffers outlive the call.
        let mut info: ShellExecuteInfo = unsafe { std::mem::zeroed() };
        info.size = std::mem::size_of::<ShellExecuteInfo>() as u32;
        info.mask = 0x40 | 0x100 | 0x400; // NOCLOSEPROCESS, NOASYNC, FLAG_NO_UI
        info.file = file.as_ptr();
        info.verb = verb.as_ptr();
        info.parameters = parameters.as_ptr();
        info.show = 0; // SW_HIDE: only Windows' consent dialog may be visible.
                       // SAFETY: info matches SHELLEXECUTEINFOW's layout and holds live UTF-16 pointers.
        if unsafe { ShellExecuteExW(&mut info) } == 0 {
            let error = std::io::Error::last_os_error();
            eprintln!("Administrator terminal approval failed: {error}");
            exit(error.raw_os_error().unwrap_or(1));
        }
        let mut code = 1;
        // SAFETY: NOCLOSEPROCESS returned this handle; this branch owns and closes it.
        unsafe {
            WaitForSingleObject(info.process, u32::MAX);
            GetExitCodeProcess(info.process, &mut code);
            CloseHandle(info.process);
        }
        exit(code as i32);
    }
    if !is_elevated() {
        crate::fail("Administrator terminal host requires Windows approval");
    }
    let program = PathBuf::from(&args[1]);
    let entry = PathBuf::from(&args[2]);
    let user_data = PathBuf::from(&args[3]);
    if !program.is_absolute()
        || !program.is_file()
        || !entry.is_absolute()
        || !entry.is_file()
        || !user_data.is_absolute()
        || !user_data.is_dir()
    {
        crate::fail("Administrator terminal host paths must be existing absolute paths");
    }
    let daemon_args = &args[4..];
    let socket = daemon_args
        .windows(2)
        .find(|pair| pair[0] == "--socket")
        .map(|pair| pair[1].clone())
        .unwrap_or_else(|| crate::fail("Administrator terminal host requires a named pipe"));
    if !socket
        .to_string_lossy()
        .starts_with(r"\\?\pipe\orca-terminal-host-")
    {
        crate::fail("Administrator terminal host requires an Orca named pipe");
    }
    for name in [
        "NODE_OPTIONS",
        "NODE_REPL_EXTERNAL_MODULE",
        "NODE_CHANNEL_FD",
    ] {
        env::remove_var(name);
    }
    env::set_var("ELECTRON_RUN_AS_NODE", "1");
    env::set_var("ORCA_USER_DATA_PATH", &user_data);
    let child = TerminalHostProcess::spawn(&program, &entry, daemon_args, &user_data)
        .unwrap_or_else(|error| {
            crate::fail(&format!("Unable to start administrator terminals: {error}"))
        });
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match allow_medium_integrity_client(&socket, child.id()) {
            Ok(true) => exit(0),
            Ok(false) if Instant::now() < deadline => {}
            Ok(false) => break,
            Err(error) => {
                child.kill();
                crate::fail(&format!(
                    "Unable to secure administrator terminal pipe: {error}"
                ));
            }
        }
        if let Some(code) = child.exit_code() {
            exit(code);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    child.kill();
    crate::fail("Administrator terminal host did not become ready");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_execute_quoting() {
        for (input, expected) in [
            ("", "\"\""),
            ("a  b", "\"a  b\""),
            ("a\"b", "\"a\\\"b\""),
            ("C:\\a b\\", "\"C:\\a b\\\\\""),
            ("雪\n$()`", "\"雪\n$()`\""),
        ] {
            assert_eq!(
                String::from_utf16(&quote(OsStr::new(input))).unwrap(),
                expected
            );
        }
    }
}
