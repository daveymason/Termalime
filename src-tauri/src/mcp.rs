use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::Instant,
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
                        },
                    );
                }
            }
        }
    }

    pub async fn start_server(&self, id: &str, config: McpServerConfig) -> Result<(), String> {
        let mut cmd = tokio::process::Command::new(&config.command);
        cmd.args(&config.args);

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
        let (transport, _stderr) = match builder.spawn() {
            Ok(t) => t,
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
                    },
                );
                return Err(err_msg);
            }
        };

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

    pub async fn restart_server(&self, id: &str) -> Result<McpServerInfo, String> {
        let config = {
            let guard = self.servers.read().await;
            guard.get(id).map(|s| s.config.clone())
        };

        let config = match config {
            Some(c) => c,
            None => {
                let file = load_mcp_config()?;
                file.mcp_servers.get(id).cloned().ok_or_else(|| format!("Server {} not found", id))?
            }
        };

        self.stop_server(id).await;
        if !config.disabled {
            let _ = self.start_server(id, config.clone()).await;
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
                status: "stopped".to_string(),
                error: None,
                tool_count: 0,
            })
        }
    }

    pub async fn get_servers_status(&self) -> Vec<McpServerInfo> {
        let guard = self.servers.read().await;
        let config_file = load_mcp_config().unwrap_or_default();
        let mut result = Vec::new();
        let mut seen = std::collections::HashSet::new();

        for (id, cfg) in config_file.mcp_servers {
            seen.insert(id.clone());
            if let Some(s) = guard.get(&id) {
                result.push(McpServerInfo {
                    id: id.clone(),
                    command: s.config.command.clone(),
                    args: s.config.args.clone(),
                    disabled: s.config.disabled,
                    status: s.status.clone(),
                    error: s.error.clone(),
                    tool_count: s.tools.len(),
                });
            } else {
                result.push(McpServerInfo {
                    id: id.clone(),
                    command: cfg.command.clone(),
                    args: cfg.args.clone(),
                    disabled: cfg.disabled,
                    status: if cfg.disabled { "stopped".to_string() } else { "starting".to_string() },
                    error: None,
                    tool_count: 0,
                });
            }
        }

        for (id, s) in guard.iter() {
            if !seen.contains(id) {
                result.push(McpServerInfo {
                    id: id.clone(),
                    command: s.config.command.clone(),
                    args: s.config.args.clone(),
                    disabled: s.config.disabled,
                    status: s.status.clone(),
                    error: s.error.clone(),
                    tool_count: s.tools.len(),
                });
            }
        }

        result.sort_by(|a, b| a.id.cmp(&b.id));
        result
    }

    pub async fn list_tools(&self) -> Vec<McpToolInfo> {
        let guard = self.servers.read().await;
        let mut result = Vec::new();
        for (server_id, server) in guard.iter() {
            if server.status != "running" {
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

        let response = peer
            .call_tool(params)
            .await
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
}
