export abstract class ProviderIdentityPort {
  abstract assertProvider(providerId: string): Promise<void>;
}

// Adapter local sem autenticação; substituir na integração com o IdP.
export class DevelopmentProviderIdentity extends ProviderIdentityPort {
  async assertProvider(_providerId: string): Promise<void> {}
}
