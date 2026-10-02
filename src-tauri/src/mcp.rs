use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use rmcp::{
    handler::client::ClientHandler,
    model::{
        CallToolRequestParams, ClientCapabilities, ClientConfig, Implementation,
        JsonObject, Tool,
    },
    service::{serve_client, Peer, RoleClient, RunningService},
    transport::child_process::TokioChildProcess,
};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct McpConfigFile {
    #[serde(rename = "mcpServers", default)]
    pub mcp_servers: HashMap<String, McpServerConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerInfo {
    pub id: String,
    pub command: String,
    pub args: Vec<String>,
    pub disabled: bool,
    pub status: String, // "running", "stopped", "error"
    pub error: Option<String>,
    pub tool_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolInfo {
    pub server_id: String,
    pub name: String,
    pub description: Option<String>,
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpCallResult {
    pub server_id: String,
    pub tool_name: String,
    pub is_error: bool,
    pub content: Vec<serde_json::Value>,
    pub duration_ms: u64,
}

pub struct TermalimeClientHandler;

impl ClientHandler for TermalimeClientHandler {
    fn get_info(&self) -> ClientConfig {
        ClientConfig::new(
            ClientCapabilities::default(),
            Implementation::new("termalime", "0.7.0"),
        )
    }
}

pub struct ActiveServer {
    pub config: McpServerConfig,
    pub peer: Option<Peer<RoleClient>>,
    pub _running_service: Option<RunningService<RoleClient, TermalimeClientHandler>>,
    pub status: String,
    pub error: Option<String>,
    pub tools: Vec<Tool>,
    pub logs: Arc<tokio::sync::Mutex<Vec<String>>>,
}

#[derive(Clone)]
pub struct McpManager {
    servers: Arc<RwLock<HashMap<String, ActiveServer>>>,
}

impl Default for McpManager {
    fn default() -> Self {
        Self {
            servers: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

pub fn get_mcp_config_path() -> PathBuf {
    if let Ok(config_home) = std::env::var("XDG_CONFIG_HOME") {
        let p = PathBuf::from(config_home).join("termalime").join("mcp.json");
        return p;
    }
    if let Ok(home) = std::env::var("HOME") {
        let p = PathBuf::from(home).join(".config").join("termalime").join("mcp.json");
        return p;
    }
    PathBuf::from("mcp.json")
}

pub fn load_mcp_config() -> Result<McpConfigFile, String> {
    let path = get_mcp_config_path();
    if !path.exists() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let default_config = McpConfigFile::default();
        if let Ok(json) = serde_json::to_string_pretty(&default_config) {
            let _ = std::fs::write(&path, json);
        }
        return Ok(default_config);
    }
    let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| format!("Failed to parse {}: {}", path.display(), e))
}

pub fn save_mcp_config(config: &McpConfigFile) -> Result<(), String> {
    let path = get_mcp_config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

impl McpManager {
    pub async fn init_from_disk(&self) {
        if let Ok(config) = load_mcp_config() {
            for (id, server_cfg) in config.mcp_servers {
                if !server_cfg.disabled {
                    let _ = self.start_server(&id, server_cfg).await;
                } else {
                    let mut guard = self.servers.write().await;
                    guard.insert(
                        id,
                        ActiveServer {
                            config: server_cfg,
                            peer: None,
                            _running_service: None,
                            status: "stopped".to_string(),
                            error: None,
                            tools: Vec::new(),
                            logs: Arc::new(tokio::sync::Mutex::new(Vec::new())),
                        },
                    );
                }
            }
        }
    }

    pub async fn start_server(&self, id: &str, config: McpServerConfig) -> Result<(), String> {
        self.stop_server(id).await;

        let mut cmd = tokio::process::Command::new(&config.command);
        cmd.args(&config.args);
        cmd.kill_on_drop(true);

        // Ensure child process inherits robust PATH including node/npx and local bin
        if let Ok(path) = std::env::var("PATH") {
            let home = std::env::var("HOME").unwrap_or_default();
            let mut extra_paths = vec![
                format!("{}/.nvm/versions/node/v22.15.1/bin", home),
                format!("{}/.cargo/bin", home),
                format!("{}/.local/bin", home),
                "/usr/local/bin".to_string(),
            ];
            extra_paths.retain(|p| !path.contains(p) && std::path::Path::new(p).exists());
            if !extra_paths.is_empty() {
                cmd.env("PATH", format!("{}:{}", extra_paths.join(":"), path));
            }
        }
        for (k, v) in &config.env {
            cmd.env(k, v);
        }

        let builder = TokioChildProcess::builder(cmd);
        let (transport, stderr_opt) = match builder.spawn() {
            Ok(p) => p,
            Err(e) => {
                let err_msg = format!("Failed to spawn {}: {}", config.command, e);
                eprintln!("[MCP] {}", err_msg);
                let mut guard = self.servers.write().await;
                guard.insert(
                    id.to_string(),
                    ActiveServer {
                        config,
                        peer: None,
                        _running_service: None,
                        status: "error".to_string(),
                        error: Some(err_msg.clone()),
                        tools: Vec::new(),
                        logs: Arc::new(tokio::sync::Mutex::new(vec![err_msg.clone()])),
                    },
                );
                return Err(err_msg);
            }
        };

        let logs_arc = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        if let Some(stderr) = stderr_opt {
            let logs_clone = logs_arc.clone();
            tokio::spawn(async move {
                use tokio::io::AsyncBufReadExt;
                let reader = tokio::io::BufReader::new(stderr);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut guard = logs_clone.lock().await;
                    if guard.len() >= 250 {
                        guard.remove(0);
                    }
                    guard.push(line);
                }
            });
        }

        let running_service = match serve_client(TermalimeClientHandler, transport).await {
            Ok(s) => s,
            Err(e) => {
                let err_msg = format!("MCP initialization error for {}: {}", id, e);
                eprintln!("[MCP] {}", err_msg);
                let mut guard = self.servers.write().await;
                guard.insert(
                    id.to_string(),
                    ActiveServer {
                        config,
                        peer: None,
                        _running_service: None,
                        status: "error".to_string(),
                        error: Some(err_msg.clone()),
                        tools: Vec::new(),
                        logs: logs_arc.clone(),
                    },
                );
                return Err(err_msg);
            }
        };

        let peer = running_service.peer().clone();

        // Discover tools from the server
        let tools = peer.list_all_tools().await.unwrap_or_default();

        let mut guard = self.servers.write().await;
        guard.insert(
            id.to_string(),
            ActiveServer {
                config,
                peer: Some(peer),
                _running_service: Some(running_service),
                status: "running".to_string(),
                error: None,
                tools,
                logs: logs_arc,
            },
        );

        Ok(())
    }

    pub async fn stop_server(&self, id: &str) {
        let mut guard = self.servers.write().await;
        if let Some(server) = guard.get_mut(id) {
            server.peer = None;
            server._running_service = None;
            server.status = "stopped".to_string();
            server.tools.clear();
        }
    }

    pub async fn remove_server(&self, id: &str) -> Result<(), String> {
        self.stop_server(id).await;
        {
            let mut guard = self.servers.write().await;
            guard.remove(id);
        }
        if let Ok(mut config) = load_mcp_config() {
            if config.mcp_servers.remove(id).is_some() {
                save_mcp_config(&config)?;
            }
        }
        Ok(())
    }

    pub async fn toggle_server(&self, id: &str, disabled: bool) -> Result<McpServerInfo, String> {
        let mut config = load_mcp_config()?;
        let server_cfg = config
            .mcp_servers
            .get_mut(id)
            .ok_or_else(|| format!("Server {} not found in configuration", id))?;
        server_cfg.disabled = disabled;
        let srv_clone = server_cfg.clone();
        save_mcp_config(&config)?;

        if disabled {
            self.stop_server(id).await;
            let mut guard = self.servers.write().await;
            if let Some(s) = guard.get_mut(id) {
                s.config.disabled = true;
                s.status = "stopped".to_string();
                s.tools.clear();
                s.error = None;
            } else {
                guard.insert(
                    id.to_string(),
                    ActiveServer {
                        config: srv_clone.clone(),
                        peer: None,
                        _running_service: None,
                        status: "stopped".to_string(),
                        error: None,
                        tools: Vec::new(),
                        logs: Arc::new(tokio::sync::Mutex::new(Vec::new())),
                    },
                );
            }
            Ok(McpServerInfo {
                id: id.to_string(),
                command: srv_clone.command,
                args: srv_clone.args,
                disabled: true,
                status: "stopped".to_string(),
                error: None,
                tool_count: 0,
            })
        } else {
            self.stop_server(id).await;
            let _ = self.start_server(id, srv_clone.clone()).await;
            let guard = self.servers.read().await;
            if let Some(s) = guard.get(id) {
                Ok(McpServerInfo {
                    id: id.to_string(),
                    command: s.config.command.clone(),
                    args: s.config.args.clone(),
                    disabled: false,
                    status: s.status.clone(),
                    error: s.error.clone(),
                    tool_count: s.tools.len(),
                })
            } else {
                Ok(McpServerInfo {
                    id: id.to_string(),
                    command: srv_clone.command,
                    args: srv_clone.args,
                    disabled: false,
                    status: "running".to_string(),
                    error: None,
                    tool_count: 0,
                })
            }
        }
    }

    pub async fn restart_server(&self, id: &str) -> Result<McpServerInfo, String> {
        let file = load_mcp_config()?;
        let config = match file.mcp_servers.get(id).cloned() {
            Some(c) => c,
            None => {
                self.stop_server(id).await;
                let mut guard = self.servers.write().await;
                guard.remove(id);
                return Err(format!("Server {} not found in configuration", id));
            }
        };

        self.stop_server(id).await;
        if !config.disabled {
            let _ = self.start_server(id, config.clone()).await;
        } else {
            let mut guard = self.servers.write().await;
            if let Some(s) = guard.get_mut(id) {
                s.config = config.clone();
                s.status = "stopped".to_string();
                s.tools.clear();
                s.error = None;
            } else {
                guard.insert(
                    id.to_string(),
                    ActiveServer {
                        config: config.clone(),
                        peer: None,
                        _running_service: None,
                        status: "stopped".to_string(),
                        error: None,
                        tools: Vec::new(),
                        logs: Arc::new(tokio::sync::Mutex::new(Vec::new())),
                    },
                );
            }
        }

        let guard = self.servers.read().await;
        if let Some(s) = guard.get(id) {
            Ok(McpServerInfo {
                id: id.to_string(),
                command: s.config.command.clone(),
                args: s.config.args.clone(),
                disabled: s.config.disabled,
                status: s.status.clone(),
                error: s.error.clone(),
                tool_count: s.tools.len(),
            })
        } else {
            Ok(McpServerInfo {
                id: id.to_string(),
                command: config.command.clone(),
                args: config.args.clone(),
                disabled: config.disabled,
                status: if config.disabled { "stopped".to_string() } else { "starting".to_string() },
                error: None,
                tool_count: 0,
            })
        }
    }

    pub async fn get_servers_status(&self) -> Vec<McpServerInfo> {
        let config_file = load_mcp_config().unwrap_or_default();

        // 1. Purge any in-memory servers that were removed from mcp.json
        let orphaned_ids: Vec<String> = {
            let guard = self.servers.read().await;
            guard
                .keys()
                .filter(|id| !config_file.mcp_servers.contains_key(*id))
                .cloned()
                .collect()
        };

        for id in orphaned_ids {
            self.stop_server(&id).await;
            let mut guard = self.servers.write().await;
            guard.remove(&id);
        }

        // 2. Return accurate server status based on mcp.json and active server state
        let guard = self.servers.read().await;
        let mut result = Vec::new();

        // Built-in Native Rust Server (Zero-Dependency)
        let native_tools = get_native_tools();
        result.push(McpServerInfo {
            id: "termalime".to_string(),
            command: "builtin (in-process rust)".to_string(),
            args: vec![
                "terminal_run_command".to_string(),
                "workspace_search".to_string(),
                "workspace_read_file".to_string(),
            ],
            disabled: false,
            status: "running".to_string(),
            error: None,
            tool_count: native_tools.len(),
        });

        for (id, cfg) in config_file.mcp_servers {
            if let Some(s) = guard.get(&id) {
                result.push(McpServerInfo {
                    id: id.clone(),
                    command: cfg.command.clone(),
                    args: cfg.args.clone(),
                    disabled: cfg.disabled,
                    status: if cfg.disabled {
                        "stopped".to_string()
                    } else {
                        s.status.clone()
                    },
                    error: if cfg.disabled { None } else { s.error.clone() },
                    tool_count: if cfg.disabled { 0 } else { s.tools.len() },
                });
            } else {
                result.push(McpServerInfo {
                    id: id.clone(),
                    command: cfg.command.clone(),
                    args: cfg.args.clone(),
                    disabled: cfg.disabled,
                    status: if cfg.disabled {
                        "stopped".to_string()
                    } else {
                        "starting".to_string()
                    },
                    error: None,
                    tool_count: 0,
                });
            }
        }

        result.sort_by(|a, b| {
            if a.id == "termalime" {
                std::cmp::Ordering::Less
            } else if b.id == "termalime" {
                std::cmp::Ordering::Greater
            } else {
                a.id.cmp(&b.id)
            }
        });
        result
    }

    pub async fn list_tools(&self) -> Vec<McpToolInfo> {
        let mut result = get_native_tools();
        let guard = self.servers.read().await;
        for (server_id, server) in guard.iter() {
            if server.status != "running" || server.config.disabled {
                continue;
            }
            for tool in &server.tools {
                let schema_val = serde_json::to_value(&tool.input_schema).unwrap_or(serde_json::json!({
                    "type": "object"
                }));
                result.push(McpToolInfo {
                    server_id: server_id.clone(),
                    name: tool.name.to_string(),
                    description: tool.description.as_ref().map(|d| d.to_string()),
                    input_schema: schema_val,
                });
            }
        }
        result
    }

    pub async fn get_server_tools(&self, id: &str) -> Vec<McpToolInfo> {
        if id == "termalime" {
            return get_native_tools();
        }
        let guard = self.servers.read().await;
        if let Some(server) = guard.get(id) {
            return server
                .tools
                .iter()
                .map(|tool| {
                    let schema_val = serde_json::to_value(&tool.input_schema).unwrap_or(serde_json::json!({
                        "type": "object"
                    }));
                    McpToolInfo {
                        server_id: id.to_string(),
                        name: tool.name.to_string(),
                        description: tool.description.as_ref().map(|d| d.to_string()),
                        input_schema: schema_val,
                    }
                })
                .collect();
        }
        Vec::new()
    }

    pub async fn get_server_logs(&self, id: &str) -> Vec<String> {
        if id == "termalime" {
            return vec![
                "[Native Engine] In-process Termalime MCP core initialized.".to_string(),
                "[Native Engine] Direct Rust execution environment: active.".to_string(),
                "[Native Engine] Registered tools: terminal_run_command, workspace_search, workspace_read_file.".to_string(),
                "[Native Engine] Status: Healthy (Zero Node.js dependency).".to_string(),
            ];
        }
        let guard = self.servers.read().await;
        if let Some(s) = guard.get(id) {
            let logs = s.logs.lock().await;
            if logs.is_empty() {
                if let Some(ref err) = s.error {
                    return vec![format!("[Error] {}", err)];
                }
                return vec![format!("[Server {}] Running. No stderr logs captured yet.", id)];
            }
            return logs.clone();
        }
        vec![format!("[Server {}] Not found or not running.", id)]
    }

    pub async fn get_ollama_tools_schema(&self) -> Vec<serde_json::Value> {
        let tools = self.list_tools().await;
        tools
            .into_iter()
            .map(|t| {
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": format!("{}__{}", t.server_id, t.name),
                        "description": t.description.unwrap_or_default(),
                        "parameters": t.input_schema
                    }
                })
            })
            .collect()
    }

    pub async fn call_tool(
        &self,
        server_id: &str,
        tool_name: &str,
        arguments: serde_json::Value,
    ) -> Result<McpCallResult, String> {
        if server_id == "termalime" || server_id == "native" {
            return self.call_native_tool(tool_name, arguments).await;
        }

        let start = Instant::now();
        let peer = {
            let guard = self.servers.read().await;
            let server = guard
                .get(server_id)
                .ok_or_else(|| format!("Server {} not found", server_id))?;
            server
                .peer
                .clone()
                .ok_or_else(|| format!("Server {} is not running", server_id))?
        };

        let json_obj = match arguments {
            serde_json::Value::Object(map) => Some(JsonObject::from_iter(map)),
            _ => None,
        };

        let mut params = CallToolRequestParams::new(tool_name.to_string());
        if let Some(args) = json_obj {
            params = params.with_arguments(args);
        }

        let response = tokio::time::timeout(
            Duration::from_secs(30),
            peer.call_tool(params),
        )
        .await
        .map_err(|_| "MCP tool call timed out after 30 seconds".to_string())?
        .map_err(|e| format!("Tool call error: {}", e))?;

        let duration_ms = start.elapsed().as_millis() as u64;

        let content_vals: Vec<serde_json::Value> = response
            .content
            .into_iter()
            .map(|c| serde_json::to_value(c).unwrap_or_default())
            .collect();

        Ok(McpCallResult {
            server_id: server_id.to_string(),
            tool_name: tool_name.to_string(),
            is_error: response.is_error.unwrap_or(false),
            content: content_vals,
            duration_ms,
        })
    }

    async fn call_native_tool(
        &self,
        tool_name: &str,
        arguments: serde_json::Value,
    ) -> Result<McpCallResult, String> {
        let start = Instant::now();
        match tool_name {
            "terminal_run_command" => {
                let cmd_str = arguments
                    .get("command")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing required parameter 'command'".to_string())?;

                let timeout_secs = arguments
                    .get("timeout_seconds")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(15)
                    .min(60);

                let mut cmd = tokio::process::Command::new("bash");
                cmd.arg("-c").arg(cmd_str);
                cmd.stdin(std::process::Stdio::null());
                cmd.stdout(std::process::Stdio::piped());
                cmd.stderr(std::process::Stdio::piped());

                let run_future = cmd.output();
                let output = tokio::time::timeout(Duration::from_secs(timeout_secs), run_future)
                    .await
                    .map_err(|_| format!("Command timed out after {} seconds", timeout_secs))?
                    .map_err(|e| format!("Failed to spawn command: {}", e))?;

                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                let exit_code = output.status.code().unwrap_or(-1);
                let is_error = !output.status.success();

                let duration_ms = start.elapsed().as_millis() as u64;
                Ok(McpCallResult {
                    server_id: "termalime".to_string(),
                    tool_name: tool_name.to_string(),
                    is_error,
                    content: vec![serde_json::json!({
                        "command": cmd_str,
                        "exit_code": exit_code,
                        "stdout": stdout,
                        "stderr": stderr,
                        "success": output.status.success()
                    })],
                    duration_ms,
                })
            }
            "workspace_search" => {
                let query = arguments
                    .get("query")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing required parameter 'query'".to_string())?
                    .to_lowercase();

                let max_results = arguments
                    .get("max_results")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(25) as usize;

                let mut matches = Vec::new();
                let root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

                fn walk_dir(dir: &std::path::Path, query: &str, matches: &mut Vec<String>, max: usize) {
                    if matches.len() >= max {
                        return;
                    }
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.flatten() {
                            if matches.len() >= max {
                                break;
                            }
                            let path = entry.path();
                            let file_name = entry.file_name().to_string_lossy().to_string();
                            if file_name.starts_with('.')
                                || file_name == "node_modules"
                                || file_name == "target"
                                || file_name == "dist"
                            {
                                continue;
                            }
                            if file_name.to_lowercase().contains(query) {
                                matches.push(path.display().to_string());
                            }
                            if path.is_dir() {
                                walk_dir(&path, query, matches, max);
                            }
                        }
                    }
                }

                walk_dir(&root, &query, &mut matches, max_results);
                let duration_ms = start.elapsed().as_millis() as u64;

                Ok(McpCallResult {
                    server_id: "termalime".to_string(),
                    tool_name: tool_name.to_string(),
                    is_error: false,
                    content: vec![serde_json::json!({
                        "query": query,
                        "count": matches.len(),
                        "results": matches
                    })],
                    duration_ms,
                })
            }
            "workspace_read_file" => {
                let file_path = arguments
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing required parameter 'path'".to_string())?;

                let max_lines = arguments
                    .get("max_lines")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(250) as usize;

                let path = std::path::Path::new(file_path);
                if !path.exists() {
                    return Err(format!("File '{}' not found", file_path));
                }
                if path.is_dir() {
                    return Err(format!("'{}' is a directory, not a file", file_path));
                }

                let content = std::fs::read_to_string(path)
                    .map_err(|e| format!("Failed to read file '{}': {}", file_path, e))?;

                let lines: Vec<&str> = content.lines().take(max_lines).collect();
                let truncated = content.lines().count() > max_lines;
                let duration_ms = start.elapsed().as_millis() as u64;

                Ok(McpCallResult {
                    server_id: "termalime".to_string(),
                    tool_name: tool_name.to_string(),
                    is_error: false,
                    content: vec![serde_json::json!({
                        "path": file_path,
                        "lines_read": lines.len(),
                        "truncated": truncated,
                        "content": lines.join("\n")
                    })],
                    duration_ms,
                })
            }
            _ => Err(format!("Unknown native tool: {}", tool_name)),
        }
    }
}

pub fn get_native_tools() -> Vec<McpToolInfo> {
    vec![
        McpToolInfo {
            server_id: "termalime".to_string(),
            name: "terminal_run_command".to_string(),
            description: Some("Executes a shell command in the system terminal environment (bash) and returns exit code, stdout, and stderr. Fast, native, and zero-dependency.".to_string()),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to execute"
                    },
                    "timeout_seconds": {
                        "type": "number",
                        "description": "Execution timeout limit in seconds (default: 15, max: 60)"
                    }
                },
                "required": ["command"]
            }),
        },
        McpToolInfo {
            server_id: "termalime".to_string(),
            name: "workspace_search".to_string(),
            description: Some("Searches for file paths matching a query substring or glob in the current workspace directory.".to_string()),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "File name substring or extension to search for"
                    },
                    "max_results": {
                        "type": "number",
                        "description": "Maximum number of search results to return (default: 25)"
                    }
                },
                "required": ["query"]
            }),
        },
        McpToolInfo {
            server_id: "termalime".to_string(),
            name: "workspace_read_file".to_string(),
            description: Some("Reads the contents of a text file from the workspace.".to_string()),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the file to read"
                    },
                    "max_lines": {
                        "type": "number",
                        "description": "Maximum lines to read from the file (default: 250)"
                    }
                },
                "required": ["path"]
            }),
        },
    ]
}
