import { invoke } from "@tauri-apps/api/core";

export interface ContextChipsState {
  lastCommand: boolean;
  gitStatus: boolean;
  cwdTree: boolean;
}

export const DEFAULT_CONTEXT_CHIPS: ContextChipsState = {
  lastCommand: false,
  gitStatus: false,
  cwdTree: false,
};

export async function gatherActiveContext(
  sessionId: string | null | undefined,
  chips: ContextChipsState,
): Promise<string> {
  const sections: string[] = [];

  if (chips.lastCommand && sessionId) {
    try {
      const output = await invoke<string>("get_last_command_output", {
        session_id: sessionId,
      });
      if (output.trim()) {
        sections.push(`[Terminal: Last Command Output]\n${output.trim()}`);
      }
    } catch (err) {
      console.warn("Failed to fetch last command output", err);
    }
  }

  if (chips.gitStatus) {
    try {
      const git = await invoke<string>("get_git_status", {
        session_id: sessionId,
      });
      if (git.trim()) {
        sections.push(`[Workspace: Git Status / Diff]\n${git.trim()}`);
      }
    } catch (err) {
      console.warn("Failed to fetch git status", err);
    }
  }

  if (chips.cwdTree) {
    try {
      const tree = await invoke<string>("get_workspace_tree", {
        session_id: sessionId,
        max_depth: 2,
      });
      if (tree.trim()) {
        sections.push(`[Workspace: Directory Tree]\n${tree.trim()}`);
      }
    } catch (err) {
      console.warn("Failed to fetch workspace tree", err);
    }
  }

  return sections.join("\n\n");
}
