import type { Message, AssistantMessage } from '../../types/message.js';

export interface ProviderUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ProviderResponse {
  id: string;
  role: 'assistant';
  content: string;
  usage: ProviderUsage;
  model: string;
  stop_reason?: string;
}

export interface ProviderStreamChunk {
  delta?: string;
  usage?: ProviderUsage;
  finish_reason?: string;
}

export interface Provider {
  name: string;
  ping_url: string;
  cost_per_1k_tokens: number;
  big_model: string;
  small_model: string;
  
  chat(params: {
    model: string;
    messages: Message[];
    system?: string;
    max_tokens?: number;
    temperature?: number;
  }): Promise<ProviderResponse>;

  stream(params: {
    model: string;
    messages: Message[];
    system?: string;
    max_tokens?: number;
    temperature?: number;
  }): AsyncIterable<ProviderStreamChunk>;
}
