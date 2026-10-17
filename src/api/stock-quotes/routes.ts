import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { stockSymbolSchema } from '../../adapters/markets/stock-quotes.js';
import type { StockQuoteService } from '../../core/integrations/stock-quote-service.js';
import { openApiSchema } from '../openapi.js';

const syncSchema = z.object({ owner: z.string().regex(/^[a-f0-9]{64}$/u), source: z.enum(['manual', 'ibkr', 'longport', 'watch']), symbols: z.array(stockSymbolSchema).max(200), revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }).strict();
const querySchema = z.object({ symbols: z.array(stockSymbolSchema).max(200) }).strict();

export function registerStockQuoteRoutes(app: FastifyInstance, service: StockQuoteService): void {
  app.post('/api/v1/stock-quotes/subscriptions', { schema: { tags: ['stock-quotes'], body: openApiSchema(syncSchema) } }, async (request) => {
    const { owner, source, symbols, revision } = syncSchema.parse(request.body);
    service.sync(owner, source, symbols, revision);
    return { ok: true, count: new Set(symbols.map((symbol) => `${symbol.market}:${symbol.symbol}`)).size };
  });
  app.post('/api/v1/stock-quotes/query', { schema: { tags: ['stock-quotes'], body: openApiSchema(querySchema) } }, async (request) => {
    const { symbols } = querySchema.parse(request.body);
    // Limit upstream fan-out while retaining per-symbol failure isolation.
    const quotes = [];
    for (let index = 0; index < symbols.length; index += 8) {
      quotes.push(...await Promise.all(symbols.slice(index, index + 8).map(async (symbol) => {
        const quote = await service.get(symbol);
        return quote ?? { ...symbol, status: 'error', error: service.error(symbol) };
      })));
    }
    return { quotes, lastUpdated: new Date().toISOString() };
  });
}
