use std::ffi::{c_void, OsStr, OsString};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use crate::terminal_host::quote;

type Handle = *mut c_void;

#[repr(C)]
struct StartupInfo {
    size: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    chars_x: u32,
    chars_y: u32,
    fill: u32,
    flags: u32,
    show: u16,
    reserved_size: u16,
    reserved_bytes: *mut u8,
    stdin: Handle,
    stdout: Handle,
    stderr: Handle,
}

#[repr(C)]
struct ProcessInfo {
    process: Handle,
    thread: Handle,
    pid: u32,
    thread_id: u32,
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateProcessW(
        application: *const u16,
        command: *mut u16,
        process_security: Handle,
        thread_security: Handle,
        inherit_handles: i32,
        flags: u32,
        environment: Handle,
        cwd: *const u16,
        startup: *mut StartupInfo,
        result: *mut ProcessInfo,
    ) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
    fn GetExitCodeProcess(handle: Handle, code: *mut u32) -> i32;
    fn TerminateProcess(handle: Handle, code: u32) -> i32;
}

pub struct TerminalHostProcess {
    handle: Handle,
    pid: u32,
}

impl TerminalHostProcess {
    pub fn spawn(
        program: &Path,
        entry: &Path,
        args: &[OsString],
        cwd: &Path,
    ) -> std::io::Result<Self> {
        let wide = |value: &OsStr| value.encode_wide().chain(Some(0)).collect::<Vec<u16>>();
        let application = wide(program.as_os_str());
        let directory = wide(cwd.as_os_str());
        let mut command = quote(program.as_os_str());
        for arg in std::iter::once(entry.as_os_str()).chain(args.iter().map(|arg| arg.as_os_str()))
        {
            command.push(32);
            command.extend(quote(arg));
        }
        command.push(0);
        // SAFETY: zero is valid for unused STARTUPINFOW fields; all buffers outlive CreateProcessW.
        unsafe {
            let mut startup: StartupInfo = std::mem::zeroed();
            startup.size = std::mem::size_of::<StartupInfo>() as u32;
            let mut info: ProcessInfo = std::mem::zeroed();
            let null = std::ptr::null_mut();
            // No inherited handles: even unrelated Node IPC and debugger sockets must stay behind.
            if CreateProcessW(
                application.as_ptr(),
                command.as_mut_ptr(),
                null,
                null,
                0,
                0x08000000 | 0x00000200,
                null,
                directory.as_ptr(),
                &mut startup,
                &mut info,
            ) == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            CloseHandle(info.thread);
            Ok(Self {
                handle: info.process,
                pid: info.pid,
            })
        }
    }

    pub fn id(&self) -> u32 {
        self.pid
    }

    pub fn exit_code(&self) -> Option<i32> {
        let mut code = 259;
        // SAFETY: this object owns the process handle until Drop.
        if unsafe { GetExitCodeProcess(self.handle, &mut code) } != 0 && code != 259 {
            Some(code as i32)
        } else {
            None
        }
    }

    pub fn kill(&self) {
        // SAFETY: the handle identifies only the child this broker created, without PID reuse.
        unsafe {
            TerminateProcess(self.handle, 1);
        }
    }
}

impl Drop for TerminalHostProcess {
    fn drop(&mut self) {
        // SAFETY: this object owns the handle; closing it leaves a successful daemon running.
        unsafe {
            CloseHandle(self.handle);
        }
    }
}
