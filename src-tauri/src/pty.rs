use std::{
    collections::HashMap,
    env,
    io::{Read, Write},
    sync::Mutex,
};

use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize as RawPtySize};
use uuid::Uuid;

/// Global registry that keeps track of PTY sessions spawned by the backend.
pub static PTY_REGISTRY: Lazy<PtyRegistry> = Lazy::new(PtyRegistry::default);

#[derive(Default)]
pub struct PtyRegistry {
    sessions: Mutex<HashMap<String, PtySession>>,
}

impl PtyRegistry {
    /// Spawns a new PTY session and stores it in the registry.
    pub fn create_session(&self, size: PtySize, shell: Option<&str>) -> Result<String> {
        let session = PtySession::spawn(size, shell)?;
        let id = session.id.clone();
        self.sessions
            .lock()
            .expect("registry mutex poisoned")
            .insert(id.clone(), session);
        Ok(id)
    }

    pub fn remove_session(&self, id: &str) {
        self.sessions
            .lock()
            .expect("registry mutex poisoned")
            .remove(id);
    }

    pub fn with_session<F, R>(&self, id: &str, f: F) -> Result<R>
    where
        F: FnOnce(&mut PtySession) -> Result<R>,
    {
        let mut sessions = self.sessions.lock().expect("registry mutex poisoned");
        let session = sessions
            .get_mut(id)
            .with_context(|| format!("PTY session {id} not found"))?;
        f(session)
    }

    pub fn take_reader(&self, id: &str) -> Result<Box<dyn Read + Send>> {
        self.with_session(id, |session| {
            session
                .take_reader()
                .with_context(|| format!("PTY reader for session {id} already taken"))
        })
    }
}

pub struct PtySession {
    pub id: String,
    master: Box<dyn MasterPty + Send>,
    #[allow(dead_code)] // Kept alive to maintain the child process
    child: Box<dyn Child + Send>,
    writer: Box<dyn Write + Send>,
    reader: Option<Box<dyn Read + Send>>,
}

impl PtySession {
    fn spawn(size: PtySize, shell: Option<&str>) -> Result<Self> {
        let shell_cmd = shell
            .map(String::from)
            .or_else(|| env::var("SHELL").ok())
            .unwrap_or_else(|| "/bin/bash".to_string());

        let system = native_pty_system();
        let pair = system
            .openpty(size.into())
            .context("failed to open PTY pair")?;

        let mut cmd = CommandBuilder::new(shell_cmd);
        cmd.arg("-i");
        cmd.env("TERM", "xterm-256color");

        let child = pair
            .slave
            .spawn_command(cmd)
            .context("failed to spawn child process")?;

        let reader = pair
            .master
            .try_clone_reader()
            .context("failed to clone PTY reader")?;

        let writer = pair
            .master
            .take_writer()
            .context("failed to take PTY writer")?;

        Ok(Self {
            id: Uuid::new_v4().to_string(),
            master: pair.master,
            child,
            writer,
            reader: Some(reader),
        })
    }

    pub fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.writer
            .write_all(bytes)
            .context("failed to write to PTY")?;
        self.writer.flush().context("failed to flush PTY writer")
    }

    pub fn resize(&mut self, size: PtySize) -> Result<()> {
        self.master
            .resize(size.into())
            .context("failed to resize PTY")
    }

    pub fn take_reader(&mut self) -> Option<Box<dyn Read + Send>> {
        self.reader.take()
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        // Reap the child so it doesn't linger as a zombie process.
        let _ = self.child.wait();
    }
}

/// High-level PTY size abstraction used by the frontend/backed bridge.
#[derive(Debug, Clone, Copy)]
pub struct PtySize {
    pub cols: u16,
    pub rows: u16,
    pub pixel_width: u16,
    pub pixel_height: u16,
}

impl Default for PtySize {
    fn default() -> Self {
        Self {
            cols: 80,
            rows: 24,
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

impl From<PtySize> for RawPtySize {
    fn from(value: PtySize) -> Self {
        RawPtySize {
            cols: value.cols,
            rows: value.rows,
            pixel_width: value.pixel_width,
            pixel_height: value.pixel_height,
        }
    }
}

impl From<&PtySize> for RawPtySize {
    fn from(value: &PtySize) -> Self {
        (*value).into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_size_is_a_standard_terminal() {
        let size = PtySize::default();
        assert_eq!(size.cols, 80);
        assert_eq!(size.rows, 24);
    }

    #[test]
    fn size_converts_to_portable_pty_size() {
        let size = PtySize {
            cols: 120,
            rows: 40,
            pixel_width: 960,
            pixel_height: 800,
        };
        let raw: RawPtySize = size.into();
        assert_eq!(raw.cols, 120);
        assert_eq!(raw.rows, 40);
        assert_eq!(raw.pixel_width, 960);
        assert_eq!(raw.pixel_height, 800);
    }

    #[test]
    fn registry_rejects_unknown_sessions() {
        let registry = PtyRegistry::default();
        assert!(registry.with_session("missing-id", |_| Ok(())).is_err());
        assert!(registry.take_reader("missing-id").is_err());
    }

    #[test]
    fn registry_spawns_writes_and_closes_sessions() {
        let registry = PtyRegistry::default();
        let id = registry
            .create_session(PtySize::default(), Some("/bin/sh"))
            .expect("should spawn a shell session");
        assert!(!id.is_empty());

        // Each spawn gets a unique id so tabs never collide.
        let second = registry
            .create_session(PtySize::default(), Some("/bin/sh"))
            .expect("should spawn a second session");
        assert_ne!(id, second);

        registry
            .with_session(&id, |session| session.write(b"true\n"))
            .expect("should write to the session");
        registry
            .with_session(&id, |session| {
                session.resize(PtySize {
                    cols: 100,
                    rows: 30,
                    pixel_width: 0,
                    pixel_height: 0,
                })
            })
            .expect("should resize the session");

        // The reader can only be taken once per session.
        assert!(registry.take_reader(&id).is_ok());
        assert!(registry.take_reader(&id).is_err());

        registry.remove_session(&id);
        registry.remove_session(&second);
        assert!(registry.with_session(&id, |_| Ok(())).is_err());
    }
}
