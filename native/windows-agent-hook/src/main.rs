//! Orca's native Windows agent hook: answers `{}`, then posts the hook payload to
//! Orca's loopback listener and waits for the reply, so status events arrive in
//! the order the agent emitted them.
//!
//! Why native: the `.cmd` form costs a cmd.exe start (plus the user's AutoRun) and
//! a curl.exe start on every event, and only an executable runs the same way under
//! Git Bash, PowerShell, and a direct CreateProcess (#20913). The contract mirrors
//! the managed Windows script in src/main/claude/hook-script.ts.
//!
//! The installed file name selects the agent profile (`claude-hook.exe`), so the
//! registered command stays a bare path that every hook runner can start as argv[0].

use std::env;
use std::fs::File;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

// Same caps as the curl form's `--connect-timeout 0.5 --max-time 1.5`.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const TOTAL_TIMEOUT: Duration = Duration::from_millis(1500);
const ENDPOINT_FILE_BYTE_LIMIT: u64 = 64 * 1024;
// Only the coordinates the POST uses; the listener validates them before publishing.
const ENDPOINT_KEYS: [&str; 4] = [
    "ORCA_AGENT_HOOK_PORT",
    "ORCA_AGENT_HOOK_TOKEN",
    "ORCA_AGENT_HOOK_ENV",
    "ORCA_AGENT_HOOK_VERSION",
];

struct Profile {
    source: &'static str,
    /// Set means the hook is not this pane's to report; exit without owning stdin.
    exit_vars: &'static [&'static str],
    /// Set means another agent imported these hooks; drain stdin and stay silent.
    drain_vars: &'static [&'static str],
}

const PROFILES: [(&str, Profile); 1] = [(
    "claude-hook",
    Profile {
        source: "claude",
        // A backgrounded session inherited the dispatching pane's env (#9236).
        exit_vars: &["CLAUDE_JOB_DIR"],
        // Grok and Devin import .claude hooks; only their own hooks report those events.
        drain_vars: &["GROK_HOOK_EVENT", "DEVIN_PROJECT_DIR"],
    },
)];

fn main() {
    let mut stdout = io::stdout();
    // Why first: Claude-compatible permission hooks fail closed on empty stdout (#14818).
    let _ = stdout.write_all(b"{}\r\n");
    let _ = stdout.flush();
    if let Some(profile) = installed_profile() {
        run(profile);
    }
    // Why always 0: a hook failure must never block or fail the agent's tool call.
    std::process::exit(0);
}

fn installed_profile() -> Option<&'static Profile> {
    let exe = env::current_exe().ok()?;
    let stem = exe.file_stem()?.to_str()?.to_ascii_lowercase();
    PROFILES
        .iter()
        .find(|(name, _)| *name == stem)
        .map(|(_, profile)| profile)
}

fn run(profile: &Profile) {
    let mut coordinates = Coordinates::from_environment();
    // Why: refresh the listener coordinates for terminals that survived an Orca restart.
    coordinates.apply_endpoint_file();
    // Why (#11549): without Orca's env the hook ran outside an Orca pane, where the caller
    // may abandon stdin; exit before reading it.
    if coordinates.port.is_empty()
        || coordinates.token.is_empty()
        || var("ORCA_PANE_KEY").is_empty()
    {
        return;
    }
    if profile.exit_vars.iter().any(|name| !var(name).is_empty()) {
        return;
    }
    let mut stdin = io::stdin().lock();
    if profile.drain_vars.iter().any(|name| !var(name).is_empty()) {
        let _ = io::copy(&mut stdin, &mut io::sink());
        return;
    }
    let mut payload = Vec::new();
    let _ = stdin.read_to_end(&mut payload);
    post(profile.source, &coordinates, &payload);
}

fn var(name: &str) -> String {
    env::var_os(name)
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default()
}

struct Coordinates {
    port: String,
    token: String,
    env: String,
    version: String,
}

impl Coordinates {
    fn from_environment() -> Self {
        Coordinates {
            port: var(ENDPOINT_KEYS[0]),
            token: var(ENDPOINT_KEYS[1]),
            env: var(ENDPOINT_KEYS[2]),
            version: var(ENDPOINT_KEYS[3]),
        }
    }

    /// Reads the `set KEY=VALUE` lines src/shared/agent-hook-listener/endpoint-publication.ts writes.
    fn apply_endpoint_file(&mut self) {
        let path = var("ORCA_AGENT_HOOK_ENDPOINT");
        if path.is_empty() {
            return;
        }
        let mut text = String::new();
        let Ok(file) = File::open(&path) else { return };
        if file
            .take(ENDPOINT_FILE_BYTE_LIMIT)
            .read_to_string(&mut text)
            .is_err()
        {
            return;
        }
        // `lines` also strips the CRLF the Windows writer emits.
        for line in text.lines() {
            let Some(assignment) = line
                .get(..4)
                .filter(|prefix| prefix.eq_ignore_ascii_case("set "))
                .and_then(|_| line.get(4..))
            else {
                continue;
            };
            let Some((key, value)) = assignment.split_once('=') else {
                continue;
            };
            let slot = match key {
                "ORCA_AGENT_HOOK_PORT" => &mut self.port,
                "ORCA_AGENT_HOOK_TOKEN" => &mut self.token,
                "ORCA_AGENT_HOOK_ENV" => &mut self.env,
                "ORCA_AGENT_HOOK_VERSION" => &mut self.version,
                _ => continue,
            };
            *slot = value.to_string();
        }
    }
}

fn post(source: &str, coordinates: &Coordinates, payload: &[u8]) {
    let Ok(port) = coordinates.port.parse::<u16>() else {
        return;
    };
    // A header value cannot carry control characters; such a token never authenticates anyway.
    if port == 0
        || coordinates
            .token
            .bytes()
            .any(|byte| byte < 0x20 || byte == 0x7f)
    {
        return;
    }
    let mut body = Vec::with_capacity(payload.len() * 3 / 2 + 512);
    for (name, value) in [
        ("paneKey", var("ORCA_PANE_KEY")),
        ("tabId", var("ORCA_TAB_ID")),
        ("launchToken", var("ORCA_AGENT_LAUNCH_TOKEN")),
        ("worktreeId", var("ORCA_WORKTREE_ID")),
        ("env", coordinates.env.clone()),
        ("version", coordinates.version.clone()),
    ] {
        append_form_field(&mut body, name, value.as_bytes());
        body.push(b'&');
    }
    append_form_field(&mut body, "payload", payload);

    let started = Instant::now();
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) else {
        return;
    };
    let head = format!(
        "POST /hook/{source} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
         Content-Type: application/x-www-form-urlencoded\r\n\
         X-Orca-Agent-Hook-Token: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        coordinates.token,
        body.len()
    );
    if !set_remaining_timeouts(&stream, started)
        || stream.write_all(head.as_bytes()).is_err()
        || !set_remaining_timeouts(&stream, started)
        || stream.write_all(&body).is_err()
    {
        return;
    }
    // Why wait for the reply: the listener applies the event before answering, and an exit
    // before that would let the agent's next event overtake this one.
    let mut reply = [0u8; 512];
    while set_remaining_timeouts(&stream, started) {
        match stream.read(&mut reply) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

fn set_remaining_timeouts(stream: &TcpStream, started: Instant) -> bool {
    let Some(remaining) = TOTAL_TIMEOUT
        .checked_sub(started.elapsed())
        .filter(|left| !left.is_zero())
    else {
        return false;
    };
    stream.set_read_timeout(Some(remaining)).is_ok()
        && stream.set_write_timeout(Some(remaining)).is_ok()
}

/// `name=value` with the value percent-encoded exactly as curl's `--data-urlencode` does.
fn append_form_field(body: &mut Vec<u8>, name: &str, value: &[u8]) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    body.extend_from_slice(name.as_bytes());
    body.push(b'=');
    for &byte in value {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            body.push(byte);
        } else {
            body.extend_from_slice(&[
                b'%',
                HEX[usize::from(byte >> 4)],
                HEX[usize::from(byte & 15)],
            ]);
        }
    }
}
