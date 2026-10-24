//! Finds the traceroute binary and builds its arguments for each platform.

use crate::net::is_ipv6;
use crate::types::{TracerouteProtocol, TracerouteRequest};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    MacOs,
    Linux,
    Windows,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "windows") {
            Platform::Windows
        } else if cfg!(target_os = "macos") {
            Platform::MacOs
        } else {
            Platform::Linux
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CommandPlan {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// The protocol the probes actually use (Windows only supports ICMP).
    pub protocol: TracerouteProtocol,
    pub probes_per_hop: u32,
    pub needs_elevation: bool,
    pub notices: Vec<String>,
}

const UNIX_FALLBACK_DIRS: &[&str] = &[
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
    "/usr/local/sbin",
    "/usr/local/bin",
];

/// tracert always sends three probes per hop.
const WINDOWS_PROBES_PER_HOP: u32 = 3;

pub fn protocol_label(protocol: TracerouteProtocol) -> &'static str {
    match protocol {
        TracerouteProtocol::Icmp => "ICMP",
        TracerouteProtocol::Udp => "UDP",
        TracerouteProtocol::Tcp => "TCP",
    }
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Searches every PATH entry, then the fallback directories, for `name`.
pub fn find_binary(
    name: &str,
    path_var: Option<&OsStr>,
    fallback_dirs: &[PathBuf],
) -> Option<PathBuf> {
    let path_dirs = path_var
        .map(|p| std::env::split_paths(p).collect::<Vec<_>>())
        .unwrap_or_default();
    path_dirs
        .iter()
        .chain(fallback_dirs.iter())
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

fn fallback_dirs(platform: Platform) -> Vec<PathBuf> {
    match platform {
        Platform::Windows => {
            let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
            vec![PathBuf::from(root).join("System32")]
        }
        Platform::MacOs | Platform::Linux => UNIX_FALLBACK_DIRS.iter().map(PathBuf::from).collect(),
    }
}

/// Directories that only root can write on a normal install.
const TRUSTED_SYSTEM_DIRS: &[&str] = &["/usr/sbin", "/usr/bin", "/sbin", "/bin"];

pub trait BinaryLocator {
    /// First executable named `name` in PATH or the fallback directories.
    fn find(&self, name: &str) -> Option<PathBuf>;

    /// A binary that is safe to run with elevated rights. PATH is not used,
    /// so a user-writable directory cannot supply a look-alike program.
    fn find_trusted(&self, name: &str) -> Option<PathBuf>;

    fn is_trusted(&self, path: &Path) -> bool;
}

pub struct SystemLocator {
    path_var: Option<OsString>,
    fallbacks: Vec<PathBuf>,
}

impl SystemLocator {
    pub fn new(platform: Platform) -> Self {
        Self {
            path_var: std::env::var_os("PATH"),
            fallbacks: fallback_dirs(platform),
        }
    }
}

impl BinaryLocator for SystemLocator {
    fn find(&self, name: &str) -> Option<PathBuf> {
        find_binary(name, self.path_var.as_deref(), &self.fallbacks)
    }

    fn find_trusted(&self, name: &str) -> Option<PathBuf> {
        TRUSTED_SYSTEM_DIRS
            .iter()
            .map(|dir| Path::new(dir).join(name))
            .find(|candidate| is_executable(candidate) && is_trusted_system_binary(candidate))
    }

    fn is_trusted(&self, path: &Path) -> bool {
        is_trusted_system_binary(path)
    }
}

/// True when `path` resolves (through symlinks such as Debian's
/// alternatives) to a root-owned file in a system directory, and neither
/// the file nor its directory is writable by group or others.
#[cfg(unix)]
pub fn is_trusted_system_binary(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(real) = std::fs::canonicalize(path) else {
        return false;
    };
    let Some(dir) = real.parent() else {
        return false;
    };
    let in_system_dir = TRUSTED_SYSTEM_DIRS
        .iter()
        .any(|trusted| std::fs::canonicalize(trusted).is_ok_and(|t| t == dir));
    let root_only =
        |p: &Path| std::fs::metadata(p).is_ok_and(|m| m.uid() == 0 && m.mode() & 0o022 == 0);
    in_system_dir && root_only(&real) && root_only(dir)
}

#[cfg(not(unix))]
pub fn is_trusted_system_binary(_path: &Path) -> bool {
    false
}

fn missing_binary_error(platform: Platform, names: &[&str]) -> String {
    match platform {
        Platform::Windows => {
            "tracert.exe was not found in PATH or in %SystemRoot%\\System32. Check that the Windows networking tools are installed and that PATH includes System32.".to_string()
        }
        Platform::Linux => format!(
            "Could not find {} in PATH or in {}. Install it with your package manager, for example `sudo apt install traceroute` (Debian/Ubuntu), `sudo dnf install traceroute` (Fedora) or `sudo pacman -S traceroute` (Arch), then run the trace again.",
            names.join(" or "),
            UNIX_FALLBACK_DIRS.join(", ")
        ),
        Platform::MacOs => format!(
            "Could not find {} in PATH or in {}. macOS ships /usr/sbin/traceroute; check that it was not removed or blocked.",
            names.join(" or "),
            UNIX_FALLBACK_DIRS.join(", ")
        ),
    }
}

/// Rejects targets that are empty or that the traceroute binary could read
/// as an option. Hostnames and IP literals only use the allowed characters.
pub fn validate_target(target: &str) -> Result<String, String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Err("Enter a hostname or IP address to trace.".to_string());
    }
    if trimmed.starts_with('-') {
        return Err(format!(
            "\"{trimmed}\" is not a valid hostname or IP address."
        ));
    }
    let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '_' | '%');
    if trimmed.len() > 253 || !trimmed.chars().all(allowed) {
        return Err(format!(
            "\"{trimmed}\" is not a valid hostname or IP address."
        ));
    }
    Ok(trimmed.to_string())
}

pub fn normalize_request(request: &TracerouteRequest) -> Result<TracerouteRequest, String> {
    Ok(TracerouteRequest {
        target: validate_target(&request.target)?,
        protocol: request.protocol,
        max_hops: request.max_hops.clamp(1, 64),
        // Per-probe wait; without an upper bound one silent hop could hold a
        // run for minutes.
        timeout_ms: request.timeout_ms.clamp(1000, 10_000),
        packet_count: request.packet_count.clamp(1, 5),
        force_fresh: request.force_fresh,
    })
}

pub fn plan_command(
    request: &TracerouteRequest,
    platform: Platform,
    locator: &dyn BinaryLocator,
) -> Result<CommandPlan, String> {
    let ipv6 = is_ipv6(&request.target);
    match platform {
        Platform::Windows => plan_windows(request, ipv6, locator),
        Platform::MacOs => plan_macos(request, ipv6, locator),
        Platform::Linux => plan_linux(request, ipv6, locator),
    }
}

fn unix_common_args(request: &TracerouteRequest) -> Vec<String> {
    vec![
        "-n".to_string(),
        "-m".to_string(),
        request.max_hops.to_string(),
        "-q".to_string(),
        request.packet_count.to_string(),
        "-w".to_string(),
        request.timeout_ms.div_ceil(1000).to_string(),
    ]
}

fn plan_windows(
    request: &TracerouteRequest,
    ipv6: bool,
    locator: &dyn BinaryLocator,
) -> Result<CommandPlan, String> {
    let program = locator
        .find("tracert.exe")
        .ok_or_else(|| missing_binary_error(Platform::Windows, &["tracert.exe"]))?;
    let mut args = vec![
        "-d".to_string(),
        "-h".to_string(),
        request.max_hops.to_string(),
        "-w".to_string(),
        request.timeout_ms.to_string(),
    ];
    if ipv6 {
        args.push("-6".to_string());
    }
    args.push(request.target.clone());

    let mut notices = Vec::new();
    if request.protocol != TracerouteProtocol::Icmp {
        notices.push(format!(
            "Windows tracert sends ICMP probes only, so this trace used ICMP instead of {}.",
            protocol_label(request.protocol)
        ));
    }
    if request.packet_count != WINDOWS_PROBES_PER_HOP {
        notices.push("Windows tracert always sends 3 probes per hop.".to_string());
    }

    Ok(CommandPlan {
        program,
        args,
        protocol: TracerouteProtocol::Icmp,
        probes_per_hop: WINDOWS_PROBES_PER_HOP,
        needs_elevation: false,
        notices,
    })
}

fn plan_macos(
    request: &TracerouteRequest,
    ipv6: bool,
    locator: &dyn BinaryLocator,
) -> Result<CommandPlan, String> {
    let name = if ipv6 { "traceroute6" } else { "traceroute" };
    // TCP probes open a packet capture, which needs root on macOS.
    let needs_elevation = request.protocol == TracerouteProtocol::Tcp;
    let program = if needs_elevation {
        locator.find_trusted(name).ok_or_else(|| {
            format!(
                "TCP traces run {name} with administrator rights, so VisTracer only uses a root-owned copy in {}. None was found.",
                TRUSTED_SYSTEM_DIRS.join(", ")
            )
        })?
    } else {
        locator
            .find(name)
            .ok_or_else(|| missing_binary_error(Platform::MacOs, &[name]))?
    };
    let mut args = unix_common_args(request);
    match (request.protocol, ipv6) {
        (TracerouteProtocol::Icmp, _) => args.insert(0, "-I".to_string()),
        (TracerouteProtocol::Tcp, false) => args.extend(["-P".to_string(), "tcp".to_string()]),
        (TracerouteProtocol::Tcp, true) => args.insert(0, "-T".to_string()),
        (TracerouteProtocol::Udp, _) => {}
    }
    args.push(request.target.clone());

    Ok(CommandPlan {
        program,
        args,
        protocol: request.protocol,
        probes_per_hop: request.packet_count,
        needs_elevation,
        notices: Vec::new(),
    })
}

fn plan_linux(
    request: &TracerouteRequest,
    ipv6: bool,
    locator: &dyn BinaryLocator,
) -> Result<CommandPlan, String> {
    let mut args = unix_common_args(request);

    // tcptraceroute only handles IPv4. Prefer it for IPv4 TCP traces when it
    // is installed; otherwise use the TCP SYN method of traceroute (-T).
    if request.protocol == TracerouteProtocol::Tcp && !ipv6 {
        if let Some(program) = locator.find("tcptraceroute") {
            args.push(request.target.clone());
            return Ok(CommandPlan {
                program,
                args,
                protocol: TracerouteProtocol::Tcp,
                probes_per_hop: request.packet_count,
                needs_elevation: false,
                notices: Vec::new(),
            });
        }
    }

    let program = if ipv6 {
        match locator.find("traceroute6") {
            Some(path) => path,
            None => {
                let path = locator.find("traceroute").ok_or_else(|| {
                    missing_binary_error(Platform::Linux, &["traceroute6", "traceroute"])
                })?;
                args.insert(0, "-6".to_string());
                path
            }
        }
    } else {
        locator
            .find("traceroute")
            .ok_or_else(|| missing_binary_error(Platform::Linux, &["traceroute"]))?
    };

    match request.protocol {
        TracerouteProtocol::Icmp => args.insert(0, "-I".to_string()),
        TracerouteProtocol::Tcp => args.insert(0, "-T".to_string()),
        TracerouteProtocol::Udp => {}
    }
    args.push(request.target.clone());

    Ok(CommandPlan {
        program,
        args,
        protocol: request.protocol,
        probes_per_hop: request.packet_count,
        needs_elevation: false,
        notices: Vec::new(),
    })
}

const PERMISSION_ERROR_MARKERS: &[&str] = &[
    "operation not permitted",
    "enough privileges",
    "permission denied",
    "got root",
    "must be root",
    "requires root",
    "are you root",
];

pub fn is_permission_error(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    PERMISSION_ERROR_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
}

/// ICMP (-I) and TCP (-T) probes need raw sockets on Linux. When such a
/// trace fails with a permission error before any hop line, this returns a
/// UDP plan for a retry plus a notice that tells the user how to enable the
/// requested protocol.
pub fn linux_permission_fallback(
    plan: &CommandPlan,
    request: &TracerouteRequest,
    platform: Platform,
    stderr: &str,
    hop_lines: usize,
    locator: &dyn BinaryLocator,
) -> Option<(CommandPlan, String)> {
    if platform != Platform::Linux
        || plan.protocol == TracerouteProtocol::Udp
        || hop_lines > 0
        || !is_permission_error(stderr)
    {
        return None;
    }

    let udp_request = TracerouteRequest {
        protocol: TracerouteProtocol::Udp,
        ..request.clone()
    };
    let udp_plan = plan_linux(&udp_request, is_ipv6(&request.target), locator).ok()?;
    let label = protocol_label(plan.protocol);
    let program = plan.program.display();
    // Only point setcap at a root-owned system binary; granting raw-socket
    // rights to a user-writable file would hand them to anyone who edits it.
    let advice = if locator.is_trusted(&plan.program) {
        format!("To use {label} without root, run once: sudo setcap cap_net_raw+ep \"$(readlink -f {program})\"")
    } else {
        format!("To use {label} without root, install traceroute from your distribution and grant cap_net_raw to that system binary. {program} is not a root-owned system binary, so do not grant it capabilities.")
    };
    let notice = format!(
        "{label} probes need raw-socket privileges on Linux, so VisTracer ran this trace again with UDP probes. {advice}"
    );
    Some((udp_plan, notice))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(target: &str, protocol: TracerouteProtocol) -> TracerouteRequest {
        TracerouteRequest {
            target: target.to_string(),
            protocol,
            max_hops: 30,
            timeout_ms: 2500,
            packet_count: 3,
            force_fresh: false,
        }
    }

    struct FakeLocator {
        available: &'static [&'static str],
        trusted: bool,
    }

    impl BinaryLocator for FakeLocator {
        fn find(&self, name: &str) -> Option<PathBuf> {
            self.available
                .contains(&name)
                .then(|| PathBuf::from(format!("/usr/sbin/{name}")))
        }
        fn find_trusted(&self, name: &str) -> Option<PathBuf> {
            self.find(name).filter(|_| self.trusted)
        }
        fn is_trusted(&self, _path: &Path) -> bool {
            self.trusted
        }
    }

    fn resolver(available: &'static [&'static str]) -> FakeLocator {
        FakeLocator {
            available,
            trusted: true,
        }
    }

    #[test]
    fn macos_icmp_uses_dash_i() {
        let plan = plan_command(
            &request("8.8.8.8", TracerouteProtocol::Icmp),
            Platform::MacOs,
            &resolver(&["traceroute"]),
        )
        .unwrap();
        assert_eq!(plan.program, PathBuf::from("/usr/sbin/traceroute"));
        assert_eq!(
            plan.args,
            ["-I", "-n", "-m", "30", "-q", "3", "-w", "3", "8.8.8.8"]
        );
        assert!(!plan.needs_elevation);
    }

    #[test]
    fn macos_tcp_needs_elevation() {
        let plan = plan_command(
            &request("example.com", TracerouteProtocol::Tcp),
            Platform::MacOs,
            &resolver(&["traceroute"]),
        )
        .unwrap();
        assert!(plan.needs_elevation);
        assert!(plan.args.windows(2).any(|w| w == ["-P", "tcp"]));
    }

    #[test]
    fn macos_ipv6_uses_traceroute6() {
        let plan = plan_command(
            &request("2001:4860:4860::8888", TracerouteProtocol::Icmp),
            Platform::MacOs,
            &resolver(&["traceroute", "traceroute6"]),
        )
        .unwrap();
        assert_eq!(plan.program, PathBuf::from("/usr/sbin/traceroute6"));
        assert_eq!(plan.args[0], "-I");
    }

    #[test]
    fn linux_tcp_prefers_tcptraceroute_for_ipv4() {
        let plan = plan_command(
            &request("1.1.1.1", TracerouteProtocol::Tcp),
            Platform::Linux,
            &resolver(&["traceroute", "tcptraceroute"]),
        )
        .unwrap();
        assert_eq!(plan.program, PathBuf::from("/usr/sbin/tcptraceroute"));
        assert!(!plan.args.contains(&"-T".to_string()));
    }

    #[test]
    fn linux_tcp_falls_back_to_traceroute_dash_t() {
        let plan = plan_command(
            &request("1.1.1.1", TracerouteProtocol::Tcp),
            Platform::Linux,
            &resolver(&["traceroute"]),
        )
        .unwrap();
        assert_eq!(plan.program, PathBuf::from("/usr/sbin/traceroute"));
        assert_eq!(plan.args[0], "-T");
    }

    #[test]
    fn linux_ipv6_tcp_skips_tcptraceroute() {
        let plan = plan_command(
            &request("2001:db8::1", TracerouteProtocol::Tcp),
            Platform::Linux,
            &resolver(&["traceroute", "tcptraceroute"]),
        )
        .unwrap();
        assert_eq!(plan.program, PathBuf::from("/usr/sbin/traceroute"));
        assert_eq!(&plan.args[..2], ["-T", "-6"]);
    }

    #[test]
    fn linux_ipv6_prefers_traceroute6() {
        let plan = plan_command(
            &request("2001:db8::1", TracerouteProtocol::Udp),
            Platform::Linux,
            &resolver(&["traceroute", "traceroute6"]),
        )
        .unwrap();
        assert_eq!(plan.program, PathBuf::from("/usr/sbin/traceroute6"));
        assert!(!plan.args.contains(&"-6".to_string()));
    }

    #[test]
    fn windows_forces_icmp_and_three_probes() {
        let mut req = request("example.com", TracerouteProtocol::Udp);
        req.packet_count = 2;
        let plan = plan_command(&req, Platform::Windows, &resolver(&["tracert.exe"])).unwrap();
        assert_eq!(plan.args, ["-d", "-h", "30", "-w", "2500", "example.com"]);
        assert_eq!(plan.protocol, TracerouteProtocol::Icmp);
        assert_eq!(plan.probes_per_hop, 3);
        assert_eq!(plan.notices.len(), 2);
    }

    #[test]
    fn missing_binary_gives_actionable_error() {
        let err = plan_command(
            &request("8.8.8.8", TracerouteProtocol::Udp),
            Platform::Linux,
            &resolver(&[]),
        )
        .unwrap_err();
        assert!(err.contains("sudo apt install traceroute"), "{err}");
    }

    #[test]
    fn linux_permission_failure_falls_back_to_udp() {
        let req = request("8.8.8.8", TracerouteProtocol::Icmp);
        let locator = resolver(&["traceroute"]);
        let plan = plan_command(&req, Platform::Linux, &locator).unwrap();
        let (fallback, notice) = linux_permission_fallback(
            &plan,
            &req,
            Platform::Linux,
            "socket: Operation not permitted",
            0,
            &locator,
        )
        .expect("fallback plan");
        assert_eq!(fallback.protocol, TracerouteProtocol::Udp);
        assert!(!fallback.args.contains(&"-I".to_string()));
        assert!(notice.contains("setcap cap_net_raw+ep"), "{notice}");

        // traceroute 2.1.x (Debian/Ubuntu) wording for -I/-T without privileges.
        assert!(is_permission_error(
            "You do not have enough privileges to use this traceroute method."
        ));
        assert!(is_permission_error("socket: Operation not permitted"));

        assert!(linux_permission_fallback(
            &plan,
            &req,
            Platform::Linux,
            "unknown host",
            0,
            &locator
        )
        .is_none());
        assert!(linux_permission_fallback(
            &plan,
            &req,
            Platform::Linux,
            "Operation not permitted",
            2,
            &locator
        )
        .is_none());
        assert!(linux_permission_fallback(
            &plan,
            &req,
            Platform::MacOs,
            "Operation not permitted",
            0,
            &locator
        )
        .is_none());
    }

    #[test]
    fn macos_tcp_refuses_binary_outside_root_owned_system_dirs() {
        let untrusted = FakeLocator {
            available: &["traceroute"],
            trusted: false,
        };
        let err = plan_command(
            &request("example.com", TracerouteProtocol::Tcp),
            Platform::MacOs,
            &untrusted,
        )
        .unwrap_err();
        assert!(err.contains("root-owned"), "{err}");
        // Unprivileged traces may still use the PATH lookup.
        assert!(plan_command(
            &request("example.com", TracerouteProtocol::Icmp),
            Platform::MacOs,
            &untrusted
        )
        .is_ok());
    }

    #[test]
    fn setcap_advice_only_targets_trusted_binaries() {
        let req = request("8.8.8.8", TracerouteProtocol::Icmp);
        let untrusted = FakeLocator {
            available: &["traceroute"],
            trusted: false,
        };
        let plan = plan_command(&req, Platform::Linux, &untrusted).unwrap();
        let (_, notice) = linux_permission_fallback(
            &plan,
            &req,
            Platform::Linux,
            "socket: Operation not permitted",
            0,
            &untrusted,
        )
        .unwrap();
        assert!(!notice.contains("readlink"), "{notice}");
        assert!(notice.contains("do not grant it capabilities"), "{notice}");
    }

    #[cfg(unix)]
    #[test]
    fn trusted_binary_check_uses_ownership_and_location() {
        assert!(is_trusted_system_binary(Path::new("/bin/sh")));
        let user_file =
            std::env::temp_dir().join(format!("vistracer-trust-{}", uuid::Uuid::new_v4()));
        std::fs::write(&user_file, "#!/bin/sh\n").unwrap();
        assert!(!is_trusted_system_binary(&user_file));
        std::fs::remove_file(&user_file).unwrap();
        assert!(!is_trusted_system_binary(Path::new(
            "/nonexistent/traceroute"
        )));
    }

    #[test]
    fn validate_target_rejects_option_like_and_odd_input() {
        assert_eq!(validate_target(" example.com ").unwrap(), "example.com");
        assert!(validate_target("2001:db8::1").is_ok());
        assert!(validate_target("").is_err());
        assert!(validate_target("-e /bin/sh").is_err());
        assert!(validate_target("example.com; rm -rf /").is_err());
    }

    #[test]
    fn normalize_request_clamps_values() {
        let mut req = request("example.com", TracerouteProtocol::Icmp);
        req.max_hops = 100;
        req.timeout_ms = 500;
        let mut long = req.clone();
        long.timeout_ms = 600_000;
        assert_eq!(normalize_request(&long).unwrap().timeout_ms, 10_000);
        req.packet_count = 10;
        let normalized = normalize_request(&req).unwrap();
        assert_eq!(normalized.max_hops, 64);
        assert_eq!(normalized.timeout_ms, 1000);
        assert_eq!(normalized.packet_count, 5);
    }

    #[cfg(unix)]
    #[test]
    fn find_binary_searches_path_then_fallbacks() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!("vistracer-bin-{}", uuid::Uuid::new_v4()));
        let path_dir = root.join("path");
        let fallback_dir = root.join("fallback");
        std::fs::create_dir_all(&path_dir).unwrap();
        std::fs::create_dir_all(&fallback_dir).unwrap();

        let make = |dir: &Path, name: &str, mode: u32| {
            let file = dir.join(name);
            std::fs::write(&file, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode)).unwrap();
            file
        };
        make(&path_dir, "traceroute", 0o644);
        let fallback = make(&fallback_dir, "traceroute", 0o755);
        let in_path = make(&path_dir, "traceroute6", 0o755);

        let path_var = std::env::join_paths([&path_dir]).unwrap();
        let fallbacks = vec![fallback_dir.clone()];

        assert_eq!(
            find_binary("traceroute6", Some(&path_var), &fallbacks),
            Some(in_path)
        );
        // A non-executable file in PATH is skipped in favour of the fallback.
        assert_eq!(
            find_binary("traceroute", Some(&path_var), &fallbacks),
            Some(fallback)
        );
        assert_eq!(
            find_binary("tcptraceroute", Some(&path_var), &fallbacks),
            None
        );
        assert_eq!(find_binary("traceroute6", None, &[]), None);

        std::fs::remove_dir_all(&root).unwrap();
    }
}
