export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_calls?: ResponseToolCall[];
}

export interface ToolMessage {
  role: 'tool';
  content: string;
  tool_call_id: string;
  name?: string;
}

export type RequestMessage = ChatMessage | ToolMessage;

export interface ResponseToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatRequest {
  model: string;
  messages: RequestMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: RequestTool[];
  tool_choice?: string | { type: string; function?: { name: string } };
}

export interface RequestTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatApiRequest extends ChatRequest {
  provider: string;
}

export interface ResponseMessage {
  role: string;
  content: string | null;
  tool_calls?: ResponseToolCall[];
}

export interface ResponseChoice {
  index: number;
  message: ResponseMessage;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string | null;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost?: number;
}

export interface ChatResponse {
  id: string;
  model: string;
  choices: ResponseChoice[];
  usage: Usage | null;
  created: number;
}
