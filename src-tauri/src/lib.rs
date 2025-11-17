pub mod pty;

use std::{collections::HashMap, io::Read, sync::Arc, time::Duration};

use anyhow::Error;
use futures_util::StreamExt;
use once_cell::sync::Lazy;
use pty::{PtySize, PTY_REGISTRY};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

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

    let reader_task = spawn_terminal_reader(app_handle, session_id.clone(), reader);
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
    let model = request.model.unwrap_or_else(|| "llama3".to_string());
    let body = json!({
        "model": model,
        "messages": [{"role": "user", "content": request.prompt}],
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
async fn check_ollama() -> Result<bool, String> {
    let response = HTTP_CLIENT
        .get("http://127.0.0.1:11434/api/tags")
        .send()
        .await
        .map_err(|err| err.to_string())?;

    Ok(response.status().is_success())
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

    let data: OllamaTagsResponse = response
        .json()
        .await
        .map_err(|err| err.to_string())?;

    let models = data.models.into_iter().map(|model| model.name).collect();
    Ok(models)
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
) -> ReaderHandle {
    tauri::async_runtime::spawn_blocking(move || {
        let mut buf = [0_u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(len) => {
                    let payload = TerminalOutputPayload {
                        session_id: session_id.clone(),
                        data: String::from_utf8_lossy(&buf[..len]).to_string(),
                    };
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

#[derive(Deserialize)]
struct OllamaResponseChunk {
    message: Option<OllamaMessage>,
    done: Option<bool>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct OllamaMessage {
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
            list_ollama_models
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
