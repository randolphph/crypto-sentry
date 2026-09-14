export type RuntimeHealthStatus = 'healthy' | 'error';

export interface RuntimeComponentHealth {
  name: string;
  status: RuntimeHealthStatus;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

export interface RuntimeHealthProvider {
  getHealth(): RuntimeComponentHealth;
}
