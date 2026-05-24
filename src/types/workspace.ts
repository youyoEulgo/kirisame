export interface WorkspaceChatRequest {
  brief: string;
  detail?: string;
}

export interface WorkspaceChatResponse {
  ok: boolean;
  task_id?: string;
  error?: string;
}

export interface BoardStatus {
  publish_count: number;
  publish_details: TaskInfo[];
}

export interface TaskInfo {
  id: string;
  from: string;
  to: string;
  brief: string;
}
