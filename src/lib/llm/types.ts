export type LLMProvider =
  | 'glm-ocr'
  | 'openai'
  | 'anthropic'
  | 'openrouter'
  | 'gemini'
  | 'ollama'
  | 'ollama-cloud'
  | 'mistral'
  | 'groq'
  | 'custom';

export interface LLMConfig {
  llm_provider: LLMProvider;
  llm_endpoint_url?: string;
  llm_openai_api_key?: string;
  llm_anthropic_api_key?: string;
  llm_openrouter_api_key?: string;
  llm_gemini_api_key?: string;
  llm_ollama_cloud_api_key?: string;
  llm_mistral_api_key?: string;
  llm_groq_api_key?: string;
  llm_glm_ocr_api_key?: string;
  llm_custom_api_key?: string;
  llm_vision_model?: string;
  llm_verification_model?: string;
}

export interface LabeledImage {
  mimeType: string;
  base64Data: string;
  /** Optional label to reference this image in the prompt */
  label?: string;
}

/** A document (e.g. PDF) sent directly to the LLM instead of rendered images. */
export interface LabeledDocument {
  /** MIME type (typically 'application/pdf') */
  mimeType: string;
  /** Base64-encoded document data */
  base64Data: string;
  /** Human-readable label for logging */
  label?: string;
}

export interface ResponseFormat {
  type: 'json' | 'text';
}

export interface VisionRequest {
  images: Array<{ mimeType: string; base64Data: string; label?: string }>;
  /** Labeled inputs for multi-source verification (images with context labels) */
  labeledInputs?: LabeledImage[];
  /** Documents (PDFs) to send directly to the LLM instead of images.
   *  When provided + supported by the provider, images are ignored.  */
  documents?: LabeledDocument[];
  prompt: string;
  /** Optional system-level instruction (passed as system message or role-based) */
  system?: string;
  /** Request structured JSON output */
  responseFormat?: ResponseFormat;
  maxTokens?: number;
  temperature?: number;
  /** Provider-specific model parameters (top_p, top_k, seed, etc.) */
  modelParams?: Record<string, unknown>;
}

export interface VisionResponse {
  content: string;
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LLMAdapter {
  buildRequest(
    config: LLMConfig,
    request: VisionRequest
  ): {
    url: string;
    headers: Record<string, string>;
    body: unknown;
  };
  parseResponse(response: unknown): VisionResponse;
}
