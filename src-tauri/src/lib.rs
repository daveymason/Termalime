pub mod pty;

use std::{collections::HashMap, io::Read, sync::Arc, time::Duration};
use tokio::sync::Mutex;

const TERMINAL_BUFFER_MAX: usize = 16 * 1024;
const TERMINAL_LINES_MAX: usize = 400;
const DEFAULT_PREFLIGHT_MODEL: &str = "gemma3:270m";
const PREFLIGHT_SYSTEM_PROMPT: &str = "You are a senior security operations (SOC) analyst. Your job is to analyze a shell command for potential risks. Do not be conversational. Respond only in JSON with the following keys: summary (one sentence), is_risky (true/false), risk_reason (one paragraph), safe_alternative (optional string offering a safer approach).";
const PREFLIGHT_REPAIR_PROMPT: &str = "You are a JSON repair bot. Convert the provided text into valid JSON with the keys summary (string), is_risky (boolean), risk_reason (string), and safe_alternative (string, optional). Respond with JSON only.";
const PREFLIGHT_TEXT_PROMPT: &str = "You are a senior SOC analyst. Provide a concise assessment of a shell command using exactly three plain-text lines, no code fences or quoting: (1) 'Summary: <what the command does>' (2) 'Likelihood of maliciousness: <percentage 0-100>' (3) 'Rationale: <explain how an attacker could abuse the command or why it's risky>'. Keep the rationale focused on potential malicious impact rather than benign behavior.";

use anyhow::Error;
use futures_util::StreamExt;
use once_cell::sync::Lazy;
use pty::{PtySize, PTY_REGISTRY};
use reqwest::Client;
use serde::{de::Error as _, Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
static HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .expect("failed to initialize reqwest client")
});

type ReaderHandle = tauri::async_runtime::JoinHandle<()>;

#[derive(Default)]
struct AppState {
    readers: Arc<Mutex<HashMap<String, ReaderHandle>>>,
    terminal_snapshots: Arc<Mutex<HashMap<String, TerminalSnapshot>>>,
}

#[derive(Default, Clone)]
struct TerminalSnapshot {
    buffer: String,
}

impl TerminalSnapshot {
    fn append(&mut self, chunk: &str) {
        self.buffer.push_str(chunk);
        if self.buffer.len() > TERMINAL_BUFFER_MAX {
            let excess = self.buffer.len() - TERMINAL_BUFFER_MAX;
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
}

#[tauri::command]
async fn get_system_context(_session_id: Option<String>) -> Result<SystemContext, String> {
    use std::env;
    use std::process::Command;

    // Get hostname
    let hostname = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok());

    // Get username
    let username = env::var("USER")
        .or_else(|_| env::var("USERNAME"))
        .ok();

    // Get shell
    let shell = env::var("SHELL")
        .ok()
        .and_then(|s| s.split('/').last().map(String::from));

    // Get current working directory
    let cwd = env::current_dir()
        .ok()
        .and_then(|p| p.to_str().map(String::from));

    // Get git branch - try from the executable's directory first (likely the project)
    let exe_dir = env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        // Go up from target/debug to project root
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));

    let git_branch = exe_dir.as_ref()
        .and_then(|dir| {
            Command::new("git")
                .args(["rev-parse", "--abbrev-ref", "HEAD"])
                .current_dir(dir)
                .stderr(std::process::Stdio::null())
                .output()
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .or_else(|| {
            // Fallback: try from cwd
            cwd.as_ref().and_then(|dir| {
                Command::new("git")
                    .args(["rev-parse", "--abbrev-ref", "HEAD"])
                    .current_dir(dir)
                    .stderr(std::process::Stdio::null())
                    .output()
                    .ok()
                    .filter(|output| output.status.success())
                    .and_then(|output| String::from_utf8(output.stdout).ok())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            })
        });

    // Get local IP address
    let local_ip = get_local_ip();

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
async fn analyze_command(request: AnalyzeCommandRequest) -> Result<AnalyzeCommandResponse, String> {
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
    let content = payload
        .get("message")
        .and_then(|msg| msg.get("content"))
        .and_then(|value| value.as_str())
        .unwrap_or("");

    let parsed_report: Option<PreflightReport> = match parse_preflight_report(content) {
        Ok(report) => Some(report),
        Err(parse_error) => match repair_preflight_report(&resolved_model, content).await {
            Ok(Some(report)) => Some(report),
            Ok(None) => {
                let assessment = fallback_text_summary(&resolved_model, &command, content, Some(&parse_error))
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
                let assessment = fallback_text_summary(&resolved_model, &command, content, Some(&parse_error))
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
    tauri::async_runtime::spawn_blocking(move || {
        let mut buf = [0_u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(len) => {
                    let chunk = String::from_utf8_lossy(&buf[..len]).to_string();
                    let payload = TerminalOutputPayload {
                        session_id: session_id.clone(),
                        data: chunk.clone(),
                    };
                    tauri::async_runtime::block_on(async {
                        let mut guard = snapshots.lock().await;
                        if let Some(snapshot) = guard.get_mut(&session_id) {
                            snapshot.append(&chunk);
                        }
                    });
                    let _ = app_handle.emit("terminal-output", payload);
                }
                Err(err) => {
                    let payload = TerminalOutputPayload {
                        session_id: session_id.clone(),
                        data: format!("[PTY ERROR] {err}"),
                    };
                    let _ = app_handle.emit("terminal-output", payload);
                    break;
                }
            }
        }
    })
}

fn suspicion_score(command: &str) -> i32 {
    let lower = command.to_lowercase();
    let mut score = 0;

    if lower.contains("sudo") {
        score += 10;
    }

    if contains_piped_interpreter(&lower) {
        score += 50;
    }

    if lower.contains("rm -rf") || lower.contains("rm -fr") {
        score += 20;
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
    let mut reasons = Vec::new();

    if contains_piped_interpreter(command) {
        reasons.push("Downloads remote content and pipes it directly into a shell");
    }

    if command.contains("rm -rf") || command.contains("rm -fr") {
        reasons.push("Contains destructive rm -rf deletion");
    }

    if command.contains("/dev/tcp") || command.contains("/dev/udp") {
        reasons.push("Uses /dev/tcp or /dev/udp for raw network sockets");
    }

    reasons
}

fn contains_piped_interpreter(command: &str) -> bool {
    let interpreters = ["| bash", "| sh", "| python", "| sudo bash", "| sudo sh"];
    let downloaders = ["curl", "wget"]; // simple heuristic

    if !command.contains('|') {
        return false;
    }

    downloaders.iter().any(|tool| command.contains(tool))
        && interpreters.iter().any(|interp| command.contains(interp))
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
            analyze_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
