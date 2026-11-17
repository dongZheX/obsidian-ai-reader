export type ApiFormat = "chat" | "responses" | "anthropic";
export type ApiFormatPref = ApiFormat | "auto";

export interface AIReaderSettings {
  apiFormat: ApiFormatPref;
  baseURL: string;
  apiKey: string;
  model: string;
  language: string;
  temperature: string;
  maxChars: number;
  maxTokens: number;
  serperKey: string;       // serper.dev key enabling the web_search tool
  skill: string;           // active reading-skill id
  customPrompt: string;    // user-defined extra instructions
  maxParallelTools: number; // concurrency for read-only tool calls
}

export const DEFAULT_SETTINGS: AIReaderSettings = {
  apiFormat: "auto",
  baseURL: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  language: "中文",
  temperature: "0.3",
  maxChars: 60000,
  maxTokens: 0,
  serperKey: "",
  skill: "deep-read",
  customPrompt: "",
  maxParallelTools: 3,
};

export type BlockType = "heading" | "paragraph" | "table" | "image" | "math" | "code";

// A unit of the source document. For Markdown, `startOffset`/`endOffset` are
// character offsets into the full document text (what we wrap when annotating),
// and `line` is the 0-based line for scroll-to. For PDF, only `page` is set.
export interface Block {
  id: number;
  type: BlockType;
  text: string;
  line?: number;
  endLine?: number;
  startOffset?: number;
  endOffset?: number;
  src?: string;        // image blocks: embedded image reference
  page?: number;       // PDF: 1-based page number
  pageLabel: string;   // display label ("?" when unknown)
}

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: any;        // string, or array (vision / anthropic tool parts)
  // anthropic/responses tool-turn plumbing:
  tool_calls?: any[];
  tool_call_id?: string;
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

export interface ToolCall { id: string; name: string; args: any; }

export interface AppliedAnnotation {
  uid: string;
  blockId: number;
  category: string | null;
  comment: string;
  color: string;
  pageLabel: string;
}

export interface Section { index: number; title: string; page: string; blockIds: number[]; }
