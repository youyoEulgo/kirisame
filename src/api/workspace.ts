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
