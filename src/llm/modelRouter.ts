import type { ModelConfig, ModelTier } from '../config/modelConfig.js'

export class ModelRouter {
  constructor(private readonly config: Pick<ModelConfig, 'flashModel' | 'proModel'>) {}

  getModel(tier: ModelTier): string {
    return tier === 'FLASH' ? this.config.flashModel : this.config.proModel
  }
}