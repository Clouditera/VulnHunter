const PROTO_API_MAP: Readonly<Record<string, string>> = {
  openai: "openai-completions",
  "openai-completions": "openai-completions",
  "openai-responses": "openai-responses",
  anthropic: "anthropic-messages",
  "anthropic-messages": "anthropic-messages",
};

/** Translate the persisted credential protocol to a Pi custom-model API id. */
export function piApiForProtocol(protocol: string): string | undefined {
  return PROTO_API_MAP[protocol];
}

export const SUPPORTED_MODEL_PROTOCOLS = Object.freeze(Object.keys(PROTO_API_MAP));
