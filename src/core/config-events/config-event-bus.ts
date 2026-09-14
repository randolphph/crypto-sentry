import { EventEmitter } from 'node:events';

export type ConfigEntity = 'integration' | 'monitor' | 'rule';
export type ConfigOperation = 'created' | 'updated' | 'deleted';

export interface ConfigChangedEvent {
  entity: ConfigEntity;
  operation: ConfigOperation;
  id: string;
}

export class ConfigEventBus {
  private readonly emitter = new EventEmitter();

  public publish(event: ConfigChangedEvent): void {
    this.emitter.emit('changed', event);
  }

  public subscribe(listener: (event: ConfigChangedEvent) => void): () => void {
    this.emitter.on('changed', listener);
    return () => this.emitter.off('changed', listener);
  }
}
