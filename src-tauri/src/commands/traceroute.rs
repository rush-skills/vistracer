//! Runs traceroute and streams hops to the renderer.
//!
//! The read loop only parses lines and emits hops. Reverse DNS, GeoLite2 and
//! provider lookups run as separate tasks (bounded by a semaphore) and emit
//! hop updates when they finish, so a slow lookup never delays later hops.

use super::geo::SharedGeoReaders;
use super::integrations::EnrichmentService;
use super::lookup::{HopLookup, IpLookup, LookupContext, LookupRequest};
use super::persistence::SharedStore;
use super::run_state::RunState;
use super::traceroute_command::{
    linux_permission_fallback, normalize_request, plan_command, CommandPlan, Platform,
    SystemLocator,
};
use super::traceroute_parse::{parse_line, ParsedLine};
use crate::types::*;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Semaphore};
use tokio::task::{Id as TaskId, JoinSet};

pub type ActiveRuns = Arc<Mutex<HashMap<String, Child>>>;

pub fn create_active_runs() -> ActiveRuns {
    Arc::new(Mutex::new(HashMap::new()))
}

const PROGRESS_EVENT: &str = "vistracer:traceroute:progress";
/// Lookups in flight per run. Provider-level limits apply on top of this.
const LOOKUP_CONCURRENCY: usize = 8;
const STDERR_LIMIT: u64 = 16 * 1024;
const ELEVATED_POLL_INTERVAL: Duration = Duration::from_millis(200);
const ELEVATED_EXIT_PREFIX: &str = "__VT_EXIT_";

pub struct TracerouteDeps {
    pub store: Arc<SharedStore>,
    pub readers: Arc<SharedGeoReaders>,
    pub enrichment: Arc<EnrichmentService>,
    pub active_runs: ActiveRuns,
}

enum ReaderEvent {
    Line(String),
    ElevatedExit(i32),
}

struct SpawnedAttempt {
    lines: mpsc::Receiver<ReaderEvent>,
    stderr: tokio::task::JoinHandle<String>,
    /// Output file of an elevated run, removed when the attempt ends.
    temp_output: Option<PathBuf>,
}

struct AttemptOutcome {
    exit_code: Option<i32>,
    stderr: String,
    cancelled: bool,
    hop_lines: usize,
}

fn lock_runs(runs: &ActiveRuns) -> std::sync::MutexGuard<'_, HashMap<String, Child>> {
    runs.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}

fn emit_progress(app: &AppHandle, event: TracerouteProgressEvent) {
    if let Err(e) = app.emit(PROGRESS_EVENT, event) {
        log::warn!("Failed to emit traceroute progress: {e}");
    }
}

fn hop_event(run_id: &str, hop: HopResolution) -> TracerouteProgressEvent {
    TracerouteProgressEvent {
        run_id: run_id.to_string(),
        hop: Some(hop),
        completed: false,
        summary: None,
        hops: None,
        error: None,
    }
}

fn emit_summary(app: &AppHandle, run_id: &str, summary: &TracerouteSummary) {
    emit_progress(
        app,
        TracerouteProgressEvent {
            run_id: run_id.to_string(),
            hop: None,
            completed: false,
            summary: Some(summary.clone()),
            hops: None,
            error: None,
        },
    );
}

fn handle_output_line(line: &str) -> ReaderEvent {
    if let Some(code) = line
        .trim()
        .strip_prefix(ELEVATED_EXIT_PREFIX)
        .and_then(|rest| rest.strip_suffix("__"))
        .and_then(|code| code.parse().ok())
    {
        return ReaderEvent::ElevatedExit(code);
    }
    ReaderEvent::Line(line.to_string())
}

/// Splits complete lines out of `pending`, decoding lossily because
/// resolver-provided host names are not guaranteed to be UTF-8.
fn drain_lines(pending: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(pos) = pending.iter().position(|b| *b == b'\n') {
        let line: Vec<u8> = pending.drain(..=pos).collect();
        lines.push(String::from_utf8_lossy(&line).trim_end().to_string());
    }
    lines
}

async fn read_pipe<R: AsyncRead + Unpin>(source: R, tx: mpsc::Sender<ReaderEvent>) {
    let mut reader = BufReader::new(source);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                if tx.send(handle_output_line(&line)).await.is_err() {
                    break;
                }
            }
            Err(e) => {
                log::error!("Error reading traceroute output: {e}");
                break;
            }
        }
    }
}

/// Follows the output file that the elevated (osascript) run writes, until
/// the exit sentinel appears or osascript exits (for example when the user
/// cancels the password prompt).
async fn tail_elevated_output(
    path: PathBuf,
    run_id: String,
    runs: ActiveRuns,
    tx: mpsc::Sender<ReaderEvent>,
) {
    let mut file = match tokio::fs::File::open(&path).await {
        Ok(file) => file,
        Err(e) => {
            log::error!("Failed to open elevated traceroute output: {e}");
            return;
        }
    };
    let mut pending = Vec::new();
    let mut chunk = vec![0u8; 8192];
    loop {
        let read = match file.read(&mut chunk).await {
            Ok(n) => n,
            Err(e) => {
                log::error!("Error reading elevated traceroute output: {e}");
                break;
            }
        };
        if read > 0 {
            pending.extend_from_slice(&chunk[..read]);
            for line in drain_lines(&mut pending) {
                let event = handle_output_line(&line);
                let done = matches!(event, ReaderEvent::ElevatedExit(_));
                if tx.send(event).await.is_err() || done {
                    return;
                }
            }
            continue;
        }

        let exited = match lock_runs(&runs).get_mut(&run_id) {
            None => true,
            Some(child) => !matches!(child.try_wait(), Ok(None)),
        };
        if exited {
            let mut rest = Vec::new();
            let _ = file.read_to_end(&mut rest).await;
            pending.extend_from_slice(&rest);
            pending.push(b'\n');
            for line in drain_lines(&mut pending) {
                if !line.is_empty() && tx.send(handle_output_line(&line)).await.is_err() {
                    return;
                }
            }
            return;
        }
        tokio::time::sleep(ELEVATED_POLL_INTERVAL).await;
    }
}

async fn read_stderr<R: AsyncRead + Unpin>(source: R) -> String {
    let mut buf = Vec::new();
    let _ = source.take(STDERR_LIMIT).read_to_end(&mut buf).await;
    String::from_utf8_lossy(&buf).trim().to_string()
}

fn shell_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\\''"))
}

/// Spawns the traceroute process and a task that forwards its output.
fn spawn_attempt(
    plan: &CommandPlan,
    run_id: &str,
    runs: &ActiveRuns,
) -> Result<SpawnedAttempt, String> {
    let (tx, rx) = mpsc::channel(64);

    if plan.needs_elevation {
        // macOS only: TCP probes need root, so the command runs through
        // osascript's administrator prompt and writes to a temp file.
        let output_path = std::env::temp_dir().join(format!("vistracer-{run_id}.out"));
        std::fs::File::create(&output_path)
            .map_err(|e| format!("Failed to create temp file: {e}"))?;
        let command_line = std::iter::once(plan.program.to_string_lossy().to_string())
            .chain(plan.args.iter().cloned())
            .map(|arg| shell_quote(&arg))
            .collect::<Vec<_>>()
            .join(" ");
        let quoted_path = shell_quote(&output_path.to_string_lossy());
        let script = format!(
            "{command_line} > {quoted_path} 2>&1; echo {ELEVATED_EXIT_PREFIX}$?__ >> {quoted_path}"
        );
        let mut child = Command::new("osascript")
            .arg("-e")
            .arg(format!(
                "do shell script \"{}\" with administrator privileges",
                script.replace('\\', "\\\\").replace('"', "\\\"")
            ))
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                format!("Failed to request administrator privileges for TCP traceroute: {e}")
            })?;
        let stderr = child.stderr.take();
        lock_runs(runs).insert(run_id.to_string(), child);
        tokio::spawn(tail_elevated_output(
            output_path.clone(),
            run_id.to_string(),
            runs.clone(),
            tx,
        ));
        let stderr_task = tokio::spawn(async move {
            match stderr {
                Some(stderr) => read_stderr(stderr).await,
                None => String::new(),
            }
        });
        return Ok(SpawnedAttempt {
            lines: rx,
            stderr: stderr_task,
            temp_output: Some(output_path),
        });
    }

    let mut child = Command::new(&plan.program)
        .args(&plan.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to start {}: {e}", plan.program.display()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture traceroute output")?;
    let stderr = child.stderr.take();
    lock_runs(runs).insert(run_id.to_string(), child);
    tokio::spawn(read_pipe(stdout, tx));
    let stderr_task = tokio::spawn(async move {
        match stderr {
            Some(stderr) => read_stderr(stderr).await,
            None => String::new(),
        }
    });
    Ok(SpawnedAttempt {
        lines: rx,
        stderr: stderr_task,
        temp_output: None,
    })
}

fn spawn_lookup<L: HopLookup>(
    lookups: &mut JoinSet<IpLookup>,
    in_flight: &mut HashMap<TaskId, LookupRequest>,
    limit: &Arc<Semaphore>,
    ctx: &Arc<L>,
    request: LookupRequest,
) {
    let limit = limit.clone();
    let ctx = ctx.clone();
    let task_request = request.clone();
    let handle = lookups.spawn(async move {
        let _permit = limit.acquire_owned().await;
        ctx.lookup(&task_request).await
    });
    in_flight.insert(handle.id(), request);
}

async fn execute_attempt<L: HopLookup>(
    plan: &CommandPlan,
    run_id: &str,
    emit: &impl Fn(TracerouteProgressEvent),
    runs: &ActiveRuns,
    ctx: &Arc<L>,
    state: &mut RunState,
) -> Result<AttemptOutcome, String> {
    let SpawnedAttempt {
        mut lines,
        stderr: stderr_task,
        temp_output,
    } = spawn_attempt(plan, run_id, runs)?;
    let limit = Arc::new(Semaphore::new(LOOKUP_CONCURRENCY));
    let mut lookups: JoinSet<IpLookup> = JoinSet::new();
    let mut in_flight: HashMap<TaskId, LookupRequest> = HashMap::new();
    let mut lines_open = true;
    let mut hop_lines = 0;
    let mut elevated_exit: Option<i32> = None;

    loop {
        tokio::select! {
            event = lines.recv(), if lines_open => match event {
                Some(ReaderEvent::Line(line)) => {
                    let parsed = parse_line(&line);
                    if matches!(parsed, ParsedLine::Hop(_)) {
                        hop_lines += 1;
                    }
                    for request in state.apply_line(parsed) {
                        spawn_lookup(&mut lookups, &mut in_flight, &limit, ctx, request);
                    }
                    for hop in state.take_changed() {
                        emit(hop_event(run_id, hop));
                    }
                }
                Some(ReaderEvent::ElevatedExit(code)) => elevated_exit = Some(code),
                None => {
                    lines_open = false;
                    if !lock_runs(runs).contains_key(run_id) {
                        lookups.abort_all();
                    }
                }
            },
            Some(joined) = lookups.join_next_with_id(), if !lookups.is_empty() => {
                match joined {
                    Ok((id, result)) => {
                        if let Some(request) = in_flight.remove(&id) {
                            state.apply_lookup(&request, result);
                        }
                    }
                    Err(err) => {
                        if !err.is_cancelled() {
                            log::error!("Lookup task failed: {err}");
                        }
                        if let Some(request) = in_flight.remove(&err.id()) {
                            state.abandon_lookup(&request);
                        }
                    }
                }
                for hop in state.take_changed() {
                    emit(hop_event(run_id, hop));
                }
            },
            else => break,
        }
    }

    if let Some(path) = temp_output {
        let _ = tokio::fs::remove_file(path).await;
    }

    let child = lock_runs(runs).remove(run_id);
    let (cancelled, process_code) = match child {
        Some(mut child) => match child.wait().await {
            Ok(status) => (false, status.code()),
            Err(e) => {
                log::error!("Failed to wait for traceroute: {e}");
                (false, None)
            }
        },
        None => (true, None),
    };
    let stderr = stderr_task.await.unwrap_or_default();

    let exit_code = if plan.needs_elevation {
        elevated_exit
    } else {
        process_code
    };
    Ok(AttemptOutcome {
        exit_code,
        stderr,
        cancelled,
        hop_lines,
    })
}

fn failure_message(plan: &CommandPlan, outcome: &AttemptOutcome) -> Option<String> {
    if outcome.cancelled {
        return Some("Traceroute run cancelled".to_string());
    }
    let first_stderr_line = outcome.stderr.lines().find(|l| !l.trim().is_empty());
    match (plan.needs_elevation, outcome.exit_code) {
        (_, Some(0)) => None,
        (true, None) => Some(format!(
            "Administrator authorization for the TCP trace was cancelled or failed{}",
            first_stderr_line
                .map(|l| format!(": {l}"))
                .unwrap_or_default()
        )),
        (_, code) => {
            let code = code.map_or("an unknown status".to_string(), |c| format!("code {c}"));
            Some(match first_stderr_line {
                Some(line) => format!("Traceroute exited with {code}: {line}"),
                None => format!("Traceroute exited with {code}"),
            })
        }
    }
}

pub async fn run_traceroute(
    request: TracerouteRequest,
    app: AppHandle,
    deps: &TracerouteDeps,
) -> Result<TracerouteExecutionResult, String> {
    let request = normalize_request(&request)?;
    let platform = Platform::current();
    let locator = SystemLocator::new(platform);
    let mut plan = plan_command(&request, platform, &locator)?;
    let run_id = uuid::Uuid::new_v4().to_string();
    log::info!(
        "Starting traceroute run {run_id} via {} {:?}",
        plan.program.display(),
        plan.args
    );

    let mut summary = TracerouteSummary {
        target: request.target.clone(),
        started_at: now_ms(),
        completed_at: None,
        hop_count: 0,
        protocols_tried: vec![plan.protocol],
        error: None,
        notices: plan.notices.clone(),
    };
    emit_summary(&app, &run_id, &summary);
    let emit = |event| emit_progress(&app, event);

    let settings = {
        let guard = deps.store.lock().unwrap_or_else(|e| e.into_inner());
        guard.integrations.clone()
    };
    let ctx = Arc::new(LookupContext {
        store: deps.store.clone(),
        readers: deps.readers.clone(),
        enrichment: deps.enrichment.clone(),
        settings,
        force_fresh: request.force_fresh,
    });

    let mut state = RunState::new(plan.probes_per_hop);
    let mut outcome =
        execute_attempt(&plan, &run_id, &emit, &deps.active_runs, &ctx, &mut state).await?;

    if !outcome.cancelled && outcome.exit_code != Some(0) {
        if let Some((udp_plan, notice)) = linux_permission_fallback(
            &plan,
            &request,
            platform,
            &outcome.stderr,
            outcome.hop_lines,
            &locator,
        ) {
            log::info!("Run {run_id}: {notice}");
            plan = udp_plan;
            summary.protocols_tried.push(plan.protocol);
            summary.notices.push(notice);
            emit_summary(&app, &run_id, &summary);
            state = RunState::new(plan.probes_per_hop);
            outcome =
                execute_attempt(&plan, &run_id, &emit, &deps.active_runs, &ctx, &mut state).await?;
        }
    }

    let hops = state.hops();
    let error = failure_message(&plan, &outcome);
    summary.completed_at = Some(now_ms());
    summary.hop_count = hops.len() as u32;
    summary.error = error.clone();

    let run = TracerouteRun {
        request,
        summary: summary.clone(),
        hops: hops.clone(),
    };
    deps.store
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .add_completed_run(run.clone());

    emit_progress(
        &app,
        TracerouteProgressEvent {
            run_id: run_id.clone(),
            hop: None,
            completed: true,
            summary: Some(summary),
            hops: Some(hops),
            error,
        },
    );

    let enrichment = deps.enrichment.clone();
    tokio::task::spawn_blocking(move || enrichment.persist());

    if outcome.cancelled {
        return Err("Traceroute run cancelled".to_string());
    }
    Ok(TracerouteExecutionResult { run_id, run })
}

pub fn cancel_traceroute(run_id: &str, active_runs: &ActiveRuns) {
    if let Some(mut child) = lock_runs(active_runs).remove(run_id) {
        match child.start_kill() {
            Ok(()) => log::info!("Cancelled traceroute run {run_id}"),
            Err(e) => log::error!("Failed to kill traceroute process {run_id}: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(needs_elevation: bool) -> CommandPlan {
        CommandPlan {
            program: PathBuf::from("/usr/sbin/traceroute"),
            args: vec![],
            protocol: TracerouteProtocol::Udp,
            probes_per_hop: 3,
            needs_elevation,
            notices: vec![],
        }
    }

    fn outcome(exit_code: Option<i32>, stderr: &str, cancelled: bool) -> AttemptOutcome {
        AttemptOutcome {
            exit_code,
            stderr: stderr.to_string(),
            cancelled,
            hop_lines: 0,
        }
    }

    #[test]
    fn failure_message_reports_stderr_and_cancellation() {
        assert_eq!(
            failure_message(&plan(false), &outcome(Some(0), "", false)),
            None
        );
        assert_eq!(
            failure_message(
                &plan(false),
                &outcome(Some(2), "\ntraceroute: unknown host nope.invalid\n", false)
            )
            .as_deref(),
            Some("Traceroute exited with code 2: traceroute: unknown host nope.invalid")
        );
        assert_eq!(
            failure_message(&plan(false), &outcome(None, "", true)).as_deref(),
            Some("Traceroute run cancelled")
        );
        assert!(
            failure_message(&plan(true), &outcome(None, "User canceled. (-128)", false))
                .unwrap()
                .contains("Administrator authorization")
        );
    }

    #[test]
    fn output_line_detects_elevated_exit_sentinel() {
        assert!(matches!(
            handle_output_line("__VT_EXIT_0__"),
            ReaderEvent::ElevatedExit(0)
        ));
        assert!(matches!(
            handle_output_line("__VT_EXIT_1__ "),
            ReaderEvent::ElevatedExit(1)
        ));
        assert!(matches!(
            handle_output_line(" 1  10.0.0.1  1 ms"),
            ReaderEvent::Line(_)
        ));
    }

    #[test]
    fn drain_lines_keeps_partial_line() {
        let mut pending = b" 1  10.0.0.1  1 ms\n 2  10.0.0".to_vec();
        assert_eq!(drain_lines(&mut pending), [" 1  10.0.0.1  1 ms"]);
        assert_eq!(pending, b" 2  10.0.0");
        pending.extend_from_slice(b".2  2 ms\r\n");
        assert_eq!(drain_lines(&mut pending), [" 2  10.0.0.2  2 ms"]);
        assert!(pending.is_empty());
    }

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[tokio::test]
    async fn pipe_reader_forwards_lines_lossily() {
        let (tx, mut rx) = mpsc::channel(8);
        let input: &[u8] = b" 1  host\xff (10.0.0.1)  1 ms\n__VT_EXIT_0__\n";
        read_pipe(input, tx).await;
        match rx.recv().await {
            Some(ReaderEvent::Line(line)) => assert!(line.starts_with(" 1  host")),
            _ => panic!("expected a line"),
        }
        assert!(matches!(
            rx.recv().await,
            Some(ReaderEvent::ElevatedExit(0))
        ));
        assert!(rx.recv().await.is_none());
    }

    /// Runs real child processes (a shell script that prints traceroute
    /// lines) through the read loop with an injected lookup worker.
    #[cfg(unix)]
    mod pipeline {
        use super::*;
        use crate::commands::lookup::LookupKind;
        use std::future::Future;
        use std::time::Instant;

        struct FakeLookup {
            slow_ip: &'static str,
            delay: Duration,
            calls: Mutex<Vec<LookupRequest>>,
        }

        impl FakeLookup {
            fn new(slow_ip: &'static str, delay: Duration) -> Arc<Self> {
                Arc::new(Self {
                    slow_ip,
                    delay,
                    calls: Mutex::new(Vec::new()),
                })
            }
        }

        impl HopLookup for FakeLookup {
            fn lookup(&self, request: &LookupRequest) -> impl Future<Output = IpLookup> + Send {
                self.calls.lock().unwrap().push(request.clone());
                let delay = if request.ip == self.slow_ip {
                    self.delay
                } else {
                    Duration::ZERO
                };
                let host_name = Some(format!("host-{}", request.ip));
                async move {
                    tokio::time::sleep(delay).await;
                    IpLookup {
                        host_name,
                        enrichment: None,
                    }
                }
            }
        }

        fn fake_traceroute(body: &str) -> (PathBuf, CommandPlan) {
            use std::os::unix::fs::PermissionsExt;
            let dir = std::env::temp_dir().join(format!("vistracer-fake-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let script = dir.join("traceroute");
            std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            let plan = CommandPlan {
                program: script,
                args: vec![],
                protocol: TracerouteProtocol::Udp,
                probes_per_hop: 1,
                needs_elevation: false,
                notices: vec![],
            };
            (dir, plan)
        }

        type Recorded = Arc<Mutex<Vec<(Duration, HopResolution)>>>;

        fn recorder(start: Instant) -> (Recorded, impl Fn(TracerouteProgressEvent)) {
            let events: Recorded = Arc::new(Mutex::new(Vec::new()));
            let sink = events.clone();
            let emit = move |event: TracerouteProgressEvent| {
                if let Some(hop) = event.hop {
                    sink.lock().unwrap().push((start.elapsed(), hop));
                }
            };
            (events, emit)
        }

        #[tokio::test]
        async fn slow_lookup_does_not_delay_later_hops() {
            let (dir, plan) = fake_traceroute(
                "echo 'traceroute to 192.0.2.9 (192.0.2.9), 3 hops max'\n\
                 echo ' 1  192.0.2.1  1.0 ms'\n\
                 sleep 0.1\n\
                 echo ' 2  192.0.2.2  2.0 ms'\n\
                 echo '    192.0.2.22  2.5 ms'\n\
                 sleep 0.1\n\
                 echo ' 3  192.0.2.9  3.0 ms'",
            );
            let lookup = FakeLookup::new("192.0.2.1", Duration::from_millis(1500));
            let runs = create_active_runs();
            let mut state = RunState::new(1);
            let start = Instant::now();
            let (events, emit) = recorder(start);

            let outcome = execute_attempt(&plan, "run-slow", &emit, &runs, &lookup, &mut state)
                .await
                .unwrap();
            assert_eq!(outcome.exit_code, Some(0));
            assert_eq!(outcome.hop_lines, 3);
            assert!(!outcome.cancelled);

            let events = events.lock().unwrap();
            let first_seen = |index: u32| {
                events
                    .iter()
                    .find(|(_, hop)| hop.hop_index == index)
                    .map(|(at, _)| *at)
                    .unwrap()
            };
            let hop1_done = events
                .iter()
                .find(|(_, hop)| hop.hop_index == 1 && hop.lookup_state == LookupState::Complete)
                .map(|(at, _)| *at)
                .unwrap();
            assert!(
                first_seen(3) < Duration::from_millis(1000),
                "hop 3 at {:?}",
                first_seen(3)
            );
            assert!(
                hop1_done >= Duration::from_millis(1400),
                "hop 1 done at {hop1_done:?}"
            );
            assert!(first_seen(3) < hop1_done);
            assert_eq!(events[0].1.lookup_state, LookupState::Pending);

            let hops = state.hops();
            assert!(hops
                .iter()
                .all(|hop| hop.lookup_state == LookupState::Complete));
            assert_eq!(hops[0].host_name.as_deref(), Some("host-192.0.2.1"));
            let multipath: Vec<_> = hops[1]
                .responders
                .iter()
                .map(|r| (r.ip_address.as_str(), r.host_name.as_deref()))
                .collect();
            assert_eq!(
                multipath,
                [
                    ("192.0.2.2", Some("host-192.0.2.2")),
                    ("192.0.2.22", Some("host-192.0.2.22"))
                ]
            );
            let calls = lookup.calls.lock().unwrap();
            assert!(calls.contains(&LookupRequest {
                ip: "192.0.2.22".into(),
                kind: LookupKind::NameOnly
            }));
            assert_eq!(calls.len(), 4);
            std::fs::remove_dir_all(dir).unwrap();
        }

        #[tokio::test]
        async fn cancel_stops_the_process_and_abandons_lookups() {
            // exec keeps a single process, like a real traceroute binary.
            let (dir, plan) = fake_traceroute("echo ' 1  192.0.2.1  1.0 ms'\nexec sleep 30");
            let lookup = FakeLookup::new("192.0.2.1", Duration::from_secs(30));
            let runs = create_active_runs();
            let mut state = RunState::new(1);
            let start = Instant::now();

            // Cancel as soon as the first hop reaches the renderer, while its
            // lookup is still in flight.
            let first_hop = Arc::new(tokio::sync::Notify::new());
            let signal = first_hop.clone();
            let emit = move |event: TracerouteProgressEvent| {
                if event.hop.is_some() {
                    signal.notify_one();
                }
            };
            let cancel_runs = runs.clone();
            tokio::spawn(async move {
                first_hop.notified().await;
                cancel_traceroute("run-cancel", &cancel_runs);
            });
            let outcome = execute_attempt(&plan, "run-cancel", &emit, &runs, &lookup, &mut state)
                .await
                .unwrap();

            assert!(outcome.cancelled);
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "took {:?}",
                start.elapsed()
            );
            let hops = state.hops();
            assert_eq!(hops.len(), 1);
            assert_eq!(hops[0].lookup_state, LookupState::Complete);
            assert_eq!(hops[0].host_name, None);
            assert!(runs.lock().unwrap().is_empty());
            std::fs::remove_dir_all(dir).unwrap();
        }

        #[tokio::test]
        async fn failing_process_reports_exit_code_and_stderr() {
            let (dir, plan) =
                fake_traceroute("echo 'traceroute: unknown host nope.invalid' >&2\nexit 2");
            let lookup = FakeLookup::new("", Duration::ZERO);
            let runs = create_active_runs();
            let mut state = RunState::new(1);
            let (_events, emit) = recorder(Instant::now());

            let outcome = execute_attempt(&plan, "run-fail", &emit, &runs, &lookup, &mut state)
                .await
                .unwrap();
            assert_eq!(outcome.exit_code, Some(2));
            assert_eq!(outcome.hop_lines, 0);
            assert_eq!(
                failure_message(&plan, &outcome).as_deref(),
                Some("Traceroute exited with code 2: traceroute: unknown host nope.invalid")
            );
            std::fs::remove_dir_all(dir).unwrap();
        }
    }
}
