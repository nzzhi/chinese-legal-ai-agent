import { z } from 'zod'

export const DEFAULT_MODEL_TIMEOUT_MS = 120_000

export const modelTierSchema = z.enum(['FLASH', 'PRO'])
export type ModelTier = z.infer<typeof modelTierSchema>

export function isAllowedModelBaseURL(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username || url.password) return false
    return url.protocol === 'https:' || (url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  } catch {
    return false
  }
}

const modelConfigSchema = z.object({
  provider: z.string().trim().min(1).default('openai-compatible'),
  apiKey: z.string({ error: 'LLM_API_KEY is required' }).trim().min(1, 'LLM_API_KEY is required'),
  baseURL: z
    .string({ error: 'LLM_BASE_URL is required' })
    .trim()
    .min(1, 'LLM_BASE_URL is required')
    .url('LLM_BASE_URL must be a valid URL')
    .refine(isAllowedModelBaseURL, 'LLM_BASE_URL must use HTTPS, except HTTP loopback for local development'),
  flashModel: z.string({ error: 'LLM_FLASH_MODEL is required' }).trim().min(1, 'LLM_FLASH_MODEL is required'),
  proModel: z.string({ error: 'LLM_PRO_MODEL is required' }).trim().min(1, 'LLM_PRO_MODEL is required'),
  timeoutMs: z.coerce.number().int().min(1).max(2_147_483_647).default(DEFAULT_MODEL_TIMEOUT_MS),
})

export interface ModelConfig {
  provider: string
  apiKey: string
  baseURL: string
  flashModel: string
  proModel: string
  timeoutMs: number
}

export function loadModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const result = modelConfigSchema.safeParse({
    provider: env.LLM_PROVIDER,
    apiKey: env.LLM_API_KEY,
    baseURL: env.LLM_BASE_URL,
    flashModel: env.LLM_FLASH_MODEL,
    proModel: env.LLM_PRO_MODEL,
    timeoutMs: env.LLM_TIMEOUT_MS,
  })

  if (!result.success) {
    const issues = result.error.issues.map((issue) => issue.message).join('; ')
    throw new Error(`Invalid model configuration: ${issues}`)
  }

  return result.data
}
