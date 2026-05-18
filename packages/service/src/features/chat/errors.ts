export class ChatCredentialUnavailableError extends Error {
  readonly code = "ERR_NO_LLM_CREDENTIAL";

  constructor(message = "当前没有可用模型凭证。请在右上角选择模型，或在 Settings 配置默认模型后重试。") {
    super(message);
    this.name = "ChatCredentialUnavailableError";
  }
}
