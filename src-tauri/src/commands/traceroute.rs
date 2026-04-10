use crate::commands::dns::resolve_reverse_dns;
use crate::commands::geo::{lookup_geo, SharedGeoReaders};
use crate::commands::persistence::SharedStore;
use crate::net::{is_ipv6, is_private_ip};
use crate::types::*;
use regex::Regex;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

pub type ActiveRuns = Arc<Mutex<HashMap<String, tokio::process::Child>>>;

pub fn create_active_runs() -> ActiveRuns {
    Arc::new(Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone)]
pub struct ParsedHop {
    pub hop_index: u32,
    pub ip_address: Option<String>,
    pub host_name: Option<String>,
    pub rtts: Vec<f64>,
    pub lost_count: u32,
    pub raw_line: String,
}

pub fn normalize_request(request: &TracerouteRequest) -> TracerouteRequest {
    TracerouteRequest {
        target: request.target.clone(),
        protocol: if request.protocol.is_empty() {
            "ICMP".to_string()
        } else {
            request.protocol.clone()
        },
        max_hops: request.max_hops.clamp(1, 64),
        timeout_ms: request.timeout_ms.max(1000),
        packet_count: request.packet_count.clamp(1, 5),
        force_fresh: request.force_fresh,
    }
}

pub fn build_command(request: &TracerouteRequest) -> (String, Vec<String>) {
    let ipv6 = is_ipv6(&request.target);

    if cfg!(target_os = "windows") {
        let mut args = vec![
            "-d".to_string(),
            "-h".to_string(),
            request.max_hops.to_string(),
            "-w".to_string(),
            request.timeout_ms.max(1000).to_string(),
        ];
        if ipv6 {
            args.push("-6".to_string());
        }
        args.push(request.target.clone());
        return ("tracert".to_string(), args);
    }

    // Unix (macOS/Linux)
    let mut args = vec![
        "-n".to_string(),
        "-m".to_string(),
        request.max_hops.to_string(),
        "-q".to_string(),
        request.packet_count.to_string(),
        "-w".to_string(),
        ((request.timeout_ms + 999) / 1000).to_string(), // ceil div
    ];

    if !ipv6 && request.protocol == "ICMP" {
        args.insert(0, "-I".to_string());
    } else if !ipv6 && request.protocol == "TCP" {
        args.push("-P".to_string());
        args.push("tcp".to_string());
    }

    args.push(request.target.clone());

    let command = if ipv6 {
        if cfg!(target_os = "macos") || cfg!(target_os = "linux") {
            "/usr/sbin/traceroute6".to_string()
        } else {
            "traceroute6".to_string()
        }
    } else if cfg!(target_os = "macos") || cfg!(target_os = "linux") {
        "/usr/sbin/traceroute".to_string()
    } else {
        "traceroute".to_string()
    };

    (command, args)
}

pub fn parse_latency_values(remainder: &str) -> Vec<f64> {
    let re = Regex::new(r"(<\d+|\d+(?:\.\d+)?)\s*ms").unwrap();
    re.captures_iter(remainder)
        .filter_map(|cap| {
            let raw = cap.get(1)?.as_str();
            if let Some(stripped) = raw.strip_prefix('<') {
                stripped.parse::<f64>().ok().or(Some(1.0))
            } else {
                raw.parse::<f64>().ok()
            }
        })
        .collect()
}

pub fn parse_hop_line(line: &str, packet_count: u32) -> Option<ParsedHop> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let hop_re = Regex::new(r"^(\d+)\s+(.*)$").unwrap();
    let caps = hop_re.captures(trimmed)?;
    let hop_index: u32 = caps.get(1)?.as_str().parse().ok()?;
    let remainder = caps.get(2)?.as_str();

    // Check for timeout
    if remainder.contains("Request timed out")
        || remainder.split_whitespace().all(|t| t == "*")
    {
        return Some(ParsedHop {
            hop_index,
            ip_address: None,
            host_name: None,
            rtts: vec![],
            lost_count: packet_count,
            raw_line: line.to_string(),
        });
    }

    let mut ip_address: Option<String> = None;
    let mut host_name: Option<String> = None;

    // Match IPv4 in parentheses: hostname (1.2.3.4)
    let paren_re = Regex::new(r"([^\s]+)?\s*\((\d{1,3}(?:\.\d{1,3}){3})\)").unwrap();
    if let Some(caps) = paren_re.captures(remainder) {
        host_name = caps.get(1).map(|m| m.as_str().to_string());
        ip_address = caps.get(2).map(|m| m.as_str().to_string());
    }

    // Match IPv6 in parentheses
    if ip_address.is_none() {
        let paren_v6_re =
            Regex::new(r"([^\s]+)?\s*\(([0-9a-fA-F:]{2,39}(?:::[0-9a-fA-F]{0,4})*)\)").unwrap();
        if let Some(caps) = paren_v6_re.captures(remainder) {
            let addr = caps.get(2).map(|m| m.as_str().to_string());
            if addr.as_ref().map_or(false, |a| a.contains(':')) {
                host_name = caps.get(1).map(|m| m.as_str().to_string());
                ip_address = addr;
            }
        }
    }

    // Match IPv4 in brackets: hostname [1.2.3.4] (Windows tracert)
    if ip_address.is_none() {
        let bracket_re = Regex::new(r"([^\s]+)?\s*\[(\d{1,3}(?:\.\d{1,3}){3})\]").unwrap();
        if let Some(caps) = bracket_re.captures(remainder) {
            host_name = caps.get(1).map(|m| m.as_str().to_string());
            ip_address = caps.get(2).map(|m| m.as_str().to_string());
        }
    }

    // Match IPv6 in brackets
    if ip_address.is_none() {
        let bracket_v6_re =
            Regex::new(r"([^\s]+)?\s*\[([0-9a-fA-F:]{2,39}(?:::[0-9a-fA-F]{0,4})*)\]").unwrap();
        if let Some(caps) = bracket_v6_re.captures(remainder) {
            let addr = caps.get(2).map(|m| m.as_str().to_string());
            if addr.as_ref().map_or(false, |a| a.contains(':')) {
                host_name = caps.get(1).map(|m| m.as_str().to_string());
                ip_address = addr;
            }
        }
    }

    // Fallback: bare IPv4
    if ip_address.is_none() {
        let ip_re = Regex::new(r"(\d{1,3}(?:\.\d{1,3}){3})").unwrap();
        if let Some(caps) = ip_re.captures(remainder) {
            ip_address = caps.get(1).map(|m| m.as_str().to_string());
        }
    }

    // Fallback: bare IPv6
    if ip_address.is_none() {
        let v6_re = Regex::new(r"([0-9a-fA-F:]{2,39}(?:::[0-9a-fA-F]{0,4})*)").unwrap();
        for caps in v6_re.captures_iter(remainder) {
            if let Some(m) = caps.get(1) {
                let addr = m.as_str();
                if addr.matches(':').count() >= 2 {
                    ip_address = Some(addr.to_string());
                    break;
                }
            }
        }
    }

    let rtts = parse_latency_values(remainder);
    let lost_count = packet_count.saturating_sub(rtts.len() as u32);

    Some(ParsedHop {
        hop_index,
        ip_address,
        host_name,
        rtts,
        lost_count,
        raw_line: line.to_string(),
    })
}

fn compute_latency_stats(values: &[f64]) -> HopLatencyStats {
    if values.is_empty() {
        return HopLatencyStats {
            min_rtt_ms: None,
            max_rtt_ms: None,
            avg_rtt_ms: None,
            jitter_ms: None,
        };
    }

    let min = values.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let avg = values.iter().sum::<f64>() / values.len() as f64;
    let jitter = if values.len() > 1 {
        Some(round2(max - min))
    } else {
        None
    };

    HopLatencyStats {
        min_rtt_ms: Some(round2(min)),
        max_rtt_ms: Some(round2(max)),
        avg_rtt_ms: Some(round2(avg)),
        jitter_ms: jitter,
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

async fn to_hop_resolution(
    parsed: &ParsedHop,
    request: &TracerouteRequest,
    store: &SharedStore,
    readers: &SharedGeoReaders,
) -> HopResolution {
    let latency = compute_latency_stats(&parsed.rtts);
    let loss_percent = if request.packet_count > 0 {
        Some(round2(
            (parsed.lost_count as f64 / request.packet_count as f64) * 100.0,
        ))
    } else {
        None
    };

    let host_name = if parsed.host_name.is_some() {
        parsed.host_name.clone()
    } else if let Some(ref ip) = parsed.ip_address {
        resolve_reverse_dns(ip, request.force_fresh, store).await
    } else {
        None
    };

    let geo_lookup = if let Some(ref ip) = parsed.ip_address {
        lookup_geo(ip, request.force_fresh, store, readers)
    } else {
        None
    };

    HopResolution {
        hop_index: parsed.hop_index,
        ip_address: parsed.ip_address.clone(),
        host_name,
        loss_percent,
        latency,
        geo: geo_lookup.as_ref().and_then(|g| g.geo.clone()),
        asn: geo_lookup.as_ref().and_then(|g| g.asn.clone()),
        is_private: parsed
            .ip_address
            .as_ref()
            .map_or(false, |ip| is_private_ip(ip)),
        is_anycast_suspected: false,
        raw_line: parsed.raw_line.clone(),
        providers: geo_lookup.as_ref().map(|g| g.providers.clone()),
        peering_db: geo_lookup.and_then(|g| g.peering_db),
    }
}

pub async fn run_traceroute(
    request: TracerouteRequest,
    app: AppHandle,
    store: &SharedStore,
    readers: &SharedGeoReaders,
    active_runs: &ActiveRuns,
) -> Result<TracerouteExecutionResult, String> {
    let normalized = normalize_request(&request);
    let (command, args) = build_command(&normalized);
    let started_at = chrono::Utc::now().timestamp_millis() as f64;
    let run_id = uuid::Uuid::new_v4().to_string();

    log::info!(
        "Starting traceroute run {} via {} {:?}",
        run_id,
        command,
        args
    );

    // Send initial progress event
    let _ = app.emit(
        "vistracer:traceroute:progress",
        TracerouteProgressEvent {
            run_id: run_id.clone(),
            hop: None,
            completed: false,
            summary: Some(TracerouteSummary {
                target: normalized.target.clone(),
                started_at,
                completed_at: None,
                hop_count: 0,
                protocols_tried: vec![normalized.protocol.clone()],
                error: None,
            }),
            hops: None,
            error: None,
        },
    );

    let needs_elevation = cfg!(target_os = "macos") && normalized.protocol == "TCP";

    // For elevated (TCP on macOS): osascript writes to a temp file, we tail it.
    // For normal: direct pipe from child stdout.
    let tmp_output_path = if needs_elevation {
        Some(std::env::temp_dir().join(format!("vistracer-{}.out", run_id)))
    } else {
        None
    };

    let child = if needs_elevation {
        let output_path = tmp_output_path.as_ref().unwrap();
        // Create the output file so tail can start reading immediately
        std::fs::File::create(output_path)
            .map_err(|e| format!("Failed to create temp file: {}", e))?;

        // TCP traceroute on macOS requires root (pcap_activate needs privileges).
        // Use osascript to show the native admin password prompt.
        // Redirect output to a temp file so we can stream-read it.
        let shell_cmd = std::iter::once(command.clone())
            .chain(args.iter().cloned())
            .map(|a| format!("'{}'", a.replace('\'', "'\\''")))
            .collect::<Vec<_>>()
            .join(" ");
        let escaped_path = output_path.to_string_lossy().replace('\'', "'\\''");
        let full_cmd = format!("{} > '{}' 2>&1; echo __VT_EXIT_$?__ >> '{}'",
            shell_cmd, escaped_path, escaped_path);
        Command::new("osascript")
            .arg("-e")
            .arg(format!(
                "do shell script \"{}\" with administrator privileges",
                full_cmd.replace('\\', "\\\\").replace('"', "\\\"")
            ))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to spawn traceroute with elevation: {}", e))?
    } else {
        Command::new(&command)
            .args(&args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to spawn traceroute: {}", e))?
    };

    // Store the child for cancellation
    {
        let mut runs = active_runs.lock().unwrap();
        runs.insert(run_id.clone(), child);
    }

    let mut hop_map: HashMap<u32, HopResolution> = HashMap::new();

    if let Some(ref output_path) = tmp_output_path {
        // Elevated mode: tail the temp file written by the osascript process.
        // We poll the file for new lines until we see the sentinel or the process exits.
        let file = tokio::fs::File::open(output_path).await
            .map_err(|e| format!("Failed to open temp output: {}", e))?;
        let mut reader = BufReader::new(file);
        let mut line_buf = String::new();
        let mut elevated_exit_code: Option<i32> = None;

        loop {
            line_buf.clear();
            match reader.read_line(&mut line_buf).await {
                Ok(0) => {
                    // No data yet — check if the osascript process has exited
                    let process_done = {
                        let runs = active_runs.lock().unwrap();
                        !runs.contains_key(&run_id)
                    };
                    if process_done {
                        // Read any remaining data
                        loop {
                            line_buf.clear();
                            match reader.read_line(&mut line_buf).await {
                                Ok(0) => break,
                                Ok(_) => {
                                    let line = line_buf.trim_end();
                                    if let Some(code_str) = line.strip_prefix("__VT_EXIT_").and_then(|s| s.strip_suffix("__")) {
                                        elevated_exit_code = code_str.parse().ok();
                                    } else if let Some(parsed) = parse_hop_line(line, normalized.packet_count) {
                                        let hop = to_hop_resolution(&parsed, &normalized, store, readers).await;
                                        hop_map.insert(hop.hop_index, hop.clone());
                                        let _ = app.emit("vistracer:traceroute:progress", TracerouteProgressEvent {
                                            run_id: run_id.clone(), hop: Some(hop), completed: false,
                                            summary: None, hops: None, error: None,
                                        });
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                        break;
                    }
                    // Poll interval
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
                Ok(_) => {
                    let line = line_buf.trim_end().to_string();
                    if let Some(code_str) = line.strip_prefix("__VT_EXIT_").and_then(|s| s.strip_suffix("__")) {
                        elevated_exit_code = code_str.parse().ok();
                        break;
                    }
                    if let Some(parsed) = parse_hop_line(&line, normalized.packet_count) {
                        let hop = to_hop_resolution(&parsed, &normalized, store, readers).await;
                        hop_map.insert(hop.hop_index, hop.clone());
                        let _ = app.emit("vistracer:traceroute:progress", TracerouteProgressEvent {
                            run_id: run_id.clone(), hop: Some(hop), completed: false,
                            summary: None, hops: None, error: None,
                        });
                    }
                }
                Err(e) => {
                    log::error!("Error reading traceroute output: {}", e);
                    break;
                }
            }
        }

        // Clean up temp file
        let _ = tokio::fs::remove_file(output_path).await;

        // Wait for osascript to exit
        let exit_result = {
            let mut runs = active_runs.lock().unwrap();
            runs.remove(&run_id)
        };
        if let Some(mut child) = exit_result {
            let _ = child.wait().await;
        }

        // Use the elevated traceroute's exit code
        let exit_code = elevated_exit_code.unwrap_or(0);

        let mut hop_list: Vec<HopResolution> = hop_map.into_values().collect();
        hop_list.sort_by_key(|h| h.hop_index);

        let error = if exit_code != 0 {
            Some(format!("Traceroute exited with code {}", exit_code))
        } else {
            None
        };

        let summary = TracerouteSummary {
            target: normalized.target.clone(),
            started_at,
            completed_at: Some(chrono::Utc::now().timestamp_millis() as f64),
            hop_count: hop_list.len() as u32,
            protocols_tried: vec![normalized.protocol.clone()],
            error: error.clone(),
        };

        let run = TracerouteRun {
            request: normalized,
            summary: summary.clone(),
            hops: hop_list.clone(),
        };

        {
            let mut guard = store.lock().unwrap();
            guard.add_completed_run(run.clone());
        }

        let _ = app.emit("vistracer:traceroute:progress", TracerouteProgressEvent {
            run_id: run_id.clone(), hop: None, completed: true,
            summary: Some(summary), hops: Some(hop_list), error,
        });

        return Ok(TracerouteExecutionResult { run_id, run });
    }

    // Normal (non-elevated) mode: read directly from child stdout
    let stdout = {
        let mut runs = active_runs.lock().unwrap();
        runs.get_mut(&run_id).and_then(|c| c.stdout.take())
    }.ok_or("Failed to capture stdout")?;

    let mut reader = BufReader::new(stdout);
    let mut line_buf = String::new();

    loop {
        line_buf.clear();
        match reader.read_line(&mut line_buf).await {
            Ok(0) => break, // EOF
            Ok(_) => {
                let line = line_buf.trim_end().to_string();
                if let Some(parsed) = parse_hop_line(&line, normalized.packet_count) {
                    let hop =
                        to_hop_resolution(&parsed, &normalized, store, readers).await;

                    hop_map.insert(hop.hop_index, hop.clone());

                    let _ = app.emit(
                        "vistracer:traceroute:progress",
                        TracerouteProgressEvent {
                            run_id: run_id.clone(),
                            hop: Some(hop),
                            completed: false,
                            summary: None,
                            hops: None,
                            error: None,
                        },
                    );
                }
            }
            Err(e) => {
                log::error!("Error reading traceroute output: {}", e);
                break;
            }
        }
    }

    // Wait for the process to finish and get exit status
    let exit_result = {
        let mut runs = active_runs.lock().unwrap();
        runs.remove(&run_id)
    };

    let was_cancelled;
    let exit_code;

    if let Some(mut child) = exit_result {
        match child.wait().await {
            Ok(status) => {
                exit_code = status.code().unwrap_or(0);
                was_cancelled = false;
            }
            Err(_) => {
                exit_code = -1;
                was_cancelled = true;
            }
        }
    } else {
        // Run was cancelled and removed from active_runs
        exit_code = -1;
        was_cancelled = true;
    }

    let mut hop_list: Vec<HopResolution> = hop_map.into_values().collect();
    hop_list.sort_by_key(|h| h.hop_index);

    let error = if was_cancelled {
        Some("Traceroute run cancelled".to_string())
    } else if exit_code != 0 {
        Some(format!("Traceroute exited with code {}", exit_code))
    } else {
        None
    };

    let summary = TracerouteSummary {
        target: normalized.target.clone(),
        started_at,
        completed_at: Some(chrono::Utc::now().timestamp_millis() as f64),
        hop_count: hop_list.len() as u32,
        protocols_tried: vec![normalized.protocol.clone()],
        error: error.clone(),
    };

    let run = TracerouteRun {
        request: normalized,
        summary: summary.clone(),
        hops: hop_list.clone(),
    };

    // Store the completed run
    {
        let mut guard = store.lock().unwrap();
        guard.add_completed_run(run.clone());
    }

    // Emit completion event
    let _ = app.emit(
        "vistracer:traceroute:progress",
        TracerouteProgressEvent {
            run_id: run_id.clone(),
            hop: None,
            completed: true,
            summary: Some(summary),
            hops: Some(hop_list),
            error: error.clone(),
        },
    );

    if was_cancelled {
        return Err("Traceroute run cancelled".to_string());
    }

    Ok(TracerouteExecutionResult {
        run_id,
        run,
    })
}

pub fn cancel_traceroute(run_id: &str, active_runs: &ActiveRuns) {
    let mut runs = active_runs.lock().unwrap();
    if let Some(mut child) = runs.remove(run_id) {
        if let Err(e) = child.start_kill() {
            log::error!("Failed to kill traceroute process {}: {}", run_id, e);
        } else {
            log::info!("Cancelled traceroute run {}", run_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_hop_line_unix() {
        let line = " 1  10.0.0.1 (10.0.0.1)  1.234 ms  0.567 ms  0.890 ms";
        let hop = parse_hop_line(line, 3).unwrap();
        assert_eq!(hop.hop_index, 1);
        assert_eq!(hop.ip_address.as_deref(), Some("10.0.0.1"));
        assert_eq!(hop.rtts.len(), 3);
    }

    #[test]
    fn test_parse_hop_line_timeout() {
        let line = " 2  * * *";
        let hop = parse_hop_line(line, 3).unwrap();
        assert_eq!(hop.hop_index, 2);
        assert!(hop.ip_address.is_none());
        assert_eq!(hop.lost_count, 3);
    }

    #[test]
    fn test_parse_hop_line_windows() {
        let line = "  3    12 ms     8 ms    10 ms  router.example.com [192.168.1.1]";
        let hop = parse_hop_line(line, 3).unwrap();
        assert_eq!(hop.hop_index, 3);
        assert_eq!(hop.ip_address.as_deref(), Some("192.168.1.1"));
    }

    #[test]
    fn test_parse_hop_line_bare_ipv4() {
        let line = " 4  8.8.8.8  10.123 ms  12.456 ms  11.789 ms";
        let hop = parse_hop_line(line, 3).unwrap();
        assert_eq!(hop.hop_index, 4);
        assert_eq!(hop.ip_address.as_deref(), Some("8.8.8.8"));
    }

    #[test]
    fn test_parse_latency_values() {
        let values = parse_latency_values("1.234 ms  0.567 ms  0.890 ms");
        assert_eq!(values.len(), 3);
        assert!((values[0] - 1.234).abs() < 0.001);
    }

    #[test]
    fn test_parse_latency_values_with_less_than() {
        let values = parse_latency_values("<1 ms  2.345 ms");
        assert_eq!(values.len(), 2);
        assert!((values[0] - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_build_command_linux() {
        let request = TracerouteRequest {
            target: "8.8.8.8".to_string(),
            protocol: "ICMP".to_string(),
            max_hops: 30,
            timeout_ms: 4000,
            packet_count: 3,
            force_fresh: false,
        };
        let (cmd, args) = build_command(&request);
        // On Linux, command should be traceroute with ICMP flag
        assert!(cmd.contains("traceroute"));
        assert!(args.contains(&"-I".to_string()) || cmd.contains("tracert"));
        assert!(args.contains(&"8.8.8.8".to_string()));
    }

    #[test]
    fn test_build_command_ipv6() {
        let request = TracerouteRequest {
            target: "2001:db8::1".to_string(),
            protocol: "ICMP".to_string(),
            max_hops: 30,
            timeout_ms: 4000,
            packet_count: 3,
            force_fresh: false,
        };
        let (cmd, _args) = build_command(&request);
        assert!(cmd.contains("traceroute6") || cmd.contains("tracert"));
    }

    #[test]
    fn test_normalize_request() {
        let request = TracerouteRequest {
            target: "example.com".to_string(),
            protocol: "".to_string(),
            max_hops: 100,
            timeout_ms: 500,
            packet_count: 10,
            force_fresh: false,
        };
        let normalized = normalize_request(&request);
        assert_eq!(normalized.protocol, "ICMP");
        assert_eq!(normalized.max_hops, 64);
        assert_eq!(normalized.timeout_ms, 1000);
        assert_eq!(normalized.packet_count, 5);
    }

    #[test]
    fn test_parse_hop_line_ipv6_bare() {
        let line = " 5  2001:4860:0:1::89b  12.345 ms  13.456 ms  14.567 ms";
        let hop = parse_hop_line(line, 3).unwrap();
        assert_eq!(hop.hop_index, 5);
        assert_eq!(hop.ip_address.as_deref(), Some("2001:4860:0:1::89b"));
    }

    #[test]
    fn test_parse_hop_line_windows_timeout() {
        let line = "  6     *        *        *     Request timed out.";
        let hop = parse_hop_line(line, 3).unwrap();
        assert_eq!(hop.hop_index, 6);
        assert!(hop.ip_address.is_none());
        assert_eq!(hop.lost_count, 3);
    }
}
