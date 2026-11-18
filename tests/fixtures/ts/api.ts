export interface ChatRequest {
  message: string;
  conversationId?: number | null;
  context?: Context;
}

export interface Context {
  title: string;
  data: { nested: boolean };
}
