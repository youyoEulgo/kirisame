import type { WorkspaceChatRequest, WorkspaceChatResponse, BoardStatus } from '@/types/workspace';

export async function sendToWorkspace(
  server: string,
  name: string,
  req: WorkspaceChatRequest,
): Promise<WorkspaceChatResponse> {
  const res = await fetch(`${server}/ws/${name}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchBoardStatus(server: string, name: string): Promise<BoardStatus> {
  const res = await fetch(`${server}/ws/${name}/tasks`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

export interface WorklogEntry {
  timestamp: number;
  agent_id: string;
  delegation_id: string;
  to_agent: string;
  description: string;
  summary: string;
  reply: string;
  artifacts: string[];
}

export interface ConversationMessage {
  delegation_id: string;
  role: string;
  content: string;
  created_at: number;
}

export async function fetchRecent(server: string, name: string): Promise<WorklogEntry[]> {
  const res = await fetch(`${server}/ws/${name}/recent`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchConversation(
  server: string,
  name: string,
): Promise<ConversationMessage[]> {
  const res = await fetch(`${server}/ws/${name}/conversation`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchWorkspaces(server: string): Promise<string[]> {
  const res = await fetch(`${server}/ws`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.workspaces ?? [];
}
