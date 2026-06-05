import type { WorkspaceChatRequest, WorkspaceChatResponse, BoardStatus } from '@/types/workspace';

export async function sendToWorkspace(
  server: string,
  name: string,
  req: WorkspaceChatRequest,
): Promise<WorkspaceChatResponse> {
  const res = await fetch(`${server}/workspace/${name}/chat`, {
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
  const res = await fetch(`${server}/workspace/${name}/tasks`);
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
  const res = await fetch(`${server}/workspace/${name}/recent`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchConversation(
  server: string,
  name: string,
): Promise<ConversationMessage[]> {
  const res = await fetch(`${server}/workspace/${name}/conversation`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchWorkspaces(server: string): Promise<string[]> {
  const res = await fetch(`${server}/workspace`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.workspaces ?? [];
}

export interface PendingHumanTask {
  session_id: string;
  message_count: number;
  tool_count: number;
  created_secs: number;
}

export async function fetchHumanRequests(server: string): Promise<PendingHumanTask[]> {
  const res = await fetch(`${server}/api/human/requests`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

export async function replyToHumanRequest(
  server: string,
  id: string,
  summary: string,
  detail: string,
): Promise<void> {
  const response = {
    id: crypto.randomUUID(),
    model: 'human',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: summary,
          tool_calls: [
            {
              id: `call_${crypto.randomUUID().slice(0, 8)}`,
              type: 'function',
              function: {
                name: 'finish',
                arguments: JSON.stringify({ summary, detail }),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    created: Math.floor(Date.now() / 1000),
  };
  await fetch(`${server}/api/human/request/${id}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response }),
  });
}
