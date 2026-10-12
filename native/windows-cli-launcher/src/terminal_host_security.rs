use std::ffi::{c_void, OsStr};
use std::os::windows::ffi::OsStrExt;

type Handle = *mut c_void;

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> Handle;
    fn CloseHandle(handle: Handle) -> i32;
    fn LocalFree(memory: Handle) -> Handle;
    fn CreateFileW(
        name: *const u16,
        access: u32,
        share: u32,
        security: Handle,
        disposition: u32,
        flags: u32,
        template: Handle,
    ) -> Handle;
    fn GetNamedPipeServerProcessId(pipe: Handle, pid: *mut u32) -> i32;
}

#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
    fn GetTokenInformation(
        token: Handle,
        class: u32,
        buffer: Handle,
        size: u32,
        returned: *mut u32,
    ) -> i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        text: *const u16,
        revision: u32,
        descriptor: *mut Handle,
        size: *mut u32,
    ) -> i32;
    fn GetSecurityDescriptorSacl(
        descriptor: Handle,
        present: *mut i32,
        sacl: *mut Handle,
        defaulted: *mut i32,
    ) -> i32;
    fn GetSecurityDescriptorDacl(
        descriptor: Handle,
        present: *mut i32,
        dacl: *mut Handle,
        defaulted: *mut i32,
    ) -> i32;
    fn ConvertSidToStringSidW(sid: Handle, text: *mut *mut u16) -> i32;
    fn SetSecurityInfo(
        handle: Handle,
        object_type: u32,
        information: u32,
        owner: Handle,
        group: Handle,
        dacl: Handle,
        sacl: Handle,
    ) -> u32;
}

pub fn is_elevated() -> bool {
    let mut token = std::ptr::null_mut();
    let mut elevation = 0u32;
    let mut size = 0;
    // SAFETY: TokenElevation is a DWORD; TOKEN_QUERY opens only the current process's token.
    unsafe {
        if OpenProcessToken(GetCurrentProcess(), 8, &mut token) == 0 {
            return false;
        }
        let ok = GetTokenInformation(
            token,
            20,
            &mut elevation as *mut u32 as Handle,
            4,
            &mut size,
        );
        CloseHandle(token);
        ok != 0 && elevation != 0
    }
}

pub fn allow_medium_integrity_client(name: &OsStr, expected_pid: u32) -> std::io::Result<bool> {
    let path: Vec<u16> = name.encode_wide().chain(Some(0)).collect();
    let null = std::ptr::null_mut();
    // SAFETY: live null-terminated path; WRITE_OWNER and WRITE_DAC permit securing this pipe.
    let pipe = unsafe { CreateFileW(path.as_ptr(), 0xc0000, 3, null, 3, 0, null) };
    if pipe as isize == -1 {
        let error = std::io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(2 | 231) => Ok(false),
            _ => Err(error),
        };
    }
    // SAFETY: this function owns pipe and descriptor; every exit closes/frees both.
    let result = unsafe {
        let mut pid = 0;
        if GetNamedPipeServerProcessId(pipe, &mut pid) == 0 || pid != expected_pid {
            Err(std::io::Error::other(
                "Named pipe is not owned by the launched terminal host",
            ))
        } else {
            set_medium_label(pipe)
        }
    };
    unsafe {
        CloseHandle(pipe);
    }
    result.map(|()| true)
}

unsafe fn set_medium_label(pipe: Handle) -> std::io::Result<()> {
    let sid = current_user_sid()?;
    // Scope control to this Windows account, SYSTEM and administrators; never Everyone or anonymous.
    // The user gets read/write without FILE_CREATE_PIPE_INSTANCE, so it cannot plant an unelevated instance.
    let text: Vec<u16> = format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x12019b;;;{sid})S:(ML;;NW;;;ME)")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let null = std::ptr::null_mut();
    let mut descriptor = null;
    if ConvertStringSecurityDescriptorToSecurityDescriptorW(
        text.as_ptr(),
        1,
        &mut descriptor,
        std::ptr::null_mut(),
    ) == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    let mut present = 0;
    let mut defaulted = 0;
    let mut sacl = null;
    let mut dacl = null;
    let result = if GetSecurityDescriptorSacl(descriptor, &mut present, &mut sacl, &mut defaulted)
        == 0
        || GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        let code = SetSecurityInfo(pipe, 6, 0x80000014, null, null, dacl, sacl);
        if code == 0 {
            Ok(())
        } else {
            Err(std::io::Error::from_raw_os_error(code as i32))
        }
    };
    LocalFree(descriptor);
    result
}

pub fn current_user_sid() -> std::io::Result<String> {
    // SAFETY: reads this process's own token; every handle and allocation is released.
    unsafe { token_user_sid() }
}

unsafe fn token_user_sid() -> std::io::Result<String> {
    let mut token = std::ptr::null_mut();
    if OpenProcessToken(GetCurrentProcess(), 8, &mut token) == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut size = 0;
    GetTokenInformation(token, 1, std::ptr::null_mut(), 0, &mut size);
    let mut user = vec![0u8; size as usize];
    let ok = GetTokenInformation(token, 1, user.as_mut_ptr() as Handle, size, &mut size);
    let error = std::io::Error::last_os_error();
    CloseHandle(token);
    if ok == 0 || user.len() < std::mem::size_of::<Handle>() {
        return Err(error);
    }
    // TOKEN_USER starts with the SID pointer; the buffer owns it until conversion finishes.
    let sid = std::ptr::read_unaligned(user.as_ptr() as *const Handle);
    let mut sid_text = std::ptr::null_mut();
    if ConvertSidToStringSidW(sid, &mut sid_text) == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut length = 0;
    while *sid_text.add(length) != 0 {
        length += 1;
    }
    let result = String::from_utf16_lossy(std::slice::from_raw_parts(sid_text, length));
    LocalFree(sid_text as Handle);
    Ok(result)
}
