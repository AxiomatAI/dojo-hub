import type { LlmProvider } from '@dojohub/contract';
import type { EmbeddingModel, LanguageModel } from 'ai';

export interface LlmModelConfig {
  provider: LlmProvider;
  model: string;
  apiKey?: string | null;
  baseUrl?: string | null;
  options?: Record<string, unknown>;
}

/** Build an AI SDK model from a BYOK configuration. Providers are loaded lazily. */
export async function createLanguageModel(cfg: LlmModelConfig): Promise<LanguageModel> {
  const apiKey = cfg.apiKey ?? undefined;
  const baseURL = cfg.baseUrl ?? undefined;
  switch (cfg.provider) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return createAnthropic({ apiKey, baseURL })(cfg.model);
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ apiKey, baseURL })(cfg.model);
    }
    case 'azure': {
      const { createAzure } = await import('@ai-sdk/azure');
      return createAzure({
        apiKey,
        baseURL,
        resourceName: cfg.options?.resourceName as string | undefined,
        apiVersion: cfg.options?.apiVersion as string | undefined,
      })(cfg.model);
    }
    case 'bedrock': {
      const { createAmazonBedrock } = await import('@ai-sdk/amazon-bedrock');
      return createAmazonBedrock({
        region: (cfg.options?.region as string | undefined) ?? process.env.AWS_REGION,
        ...(apiKey ? { apiKey } : {}),
      })(cfg.model);
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return createGoogleGenerativeAI({ apiKey, baseURL })(cfg.model);
    }
    case 'openai-compatible': {
      const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
      if (!baseURL)
        throw new Error('baseUrl is required for OpenAI-compatible providers (e.g. Ollama, vLLM)');
      return createOpenAICompatible({ name: 'custom', apiKey, baseURL })(cfg.model);
    }
  }
}

export async function createEmbeddingModel(cfg: LlmModelConfig): Promise<EmbeddingModel> {
  const apiKey = cfg.apiKey ?? undefined;
  const baseURL = cfg.baseUrl ?? undefined;
  switch (cfg.provider) {
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ apiKey, baseURL }).embeddingModel(cfg.model);
    }
    case 'azure': {
      const { createAzure } = await import('@ai-sdk/azure');
      return createAzure({
        apiKey,
        baseURL,
        resourceName: cfg.options?.resourceName as string | undefined,
      }).embeddingModel(cfg.model);
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return createGoogleGenerativeAI({ apiKey, baseURL }).embeddingModel(cfg.model);
    }
    case 'bedrock': {
      const { createAmazonBedrock } = await import('@ai-sdk/amazon-bedrock');
      return createAmazonBedrock({
        region: (cfg.options?.region as string | undefined) ?? process.env.AWS_REGION,
      }).embeddingModel(cfg.model);
    }
    case 'openai-compatible': {
      const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
      if (!baseURL) throw new Error('baseUrl is required for OpenAI-compatible providers');
      return createOpenAICompatible({ name: 'custom', apiKey, baseURL }).embeddingModel(cfg.model);
    }
    case 'anthropic':
      throw new Error(
        'Anthropic does not provide embedding models; configure OpenAI, Azure, Google, Bedrock or an OpenAI-compatible endpoint',
      );
  }
}
