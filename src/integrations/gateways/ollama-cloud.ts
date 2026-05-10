import { defineGateway } from '../define.js'

export default defineGateway({
  id: 'ollama-cloud',
  label: 'Ollama Cloud',
  category: 'hosted',
  defaultBaseUrl: 'https://ollama.com/v1',
  defaultModel: 'llama3.3',
  supportsModelRouting: true,
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
  },
  startup: {
    autoDetectable: false,
    probeReadiness: 'openai-compatible-models',
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      supportsAuthHeaders: true,
      maxTokensField: 'max_tokens',
    },
  },
  preset: {
    id: 'ollama-cloud',
    description: 'Ollama Cloud hosted models (ollama.com)',
    apiKeyEnvVars: ['OLLAMA_CLOUD_API_KEY'],
    modelEnvVars: ['OPENAI_MODEL'],
    vendorId: 'openai',
  },
  catalog: {
    source: 'dynamic',
    discovery: { kind: 'openai-compatible' },
    discoveryCacheTtl: '1d',
    discoveryRefreshMode: 'background-if-stale',
    allowManualRefresh: true,
  },
  usage: { supported: false },
})
