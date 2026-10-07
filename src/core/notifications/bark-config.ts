import { z } from 'zod';

export const barkConfigSchema = z.object({
  serverUrl: z.url().refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, 'Expected an HTTP/HTTPS server address without credentials, query or fragment').default('https://api.day.app'),
  deviceKey: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/u, 'Expected a Bark device key').refine((value) => value !== '********'),
  group: z.string().trim().max(100).default('CryptoSentry'),
}).strict();

export type BarkConfig = z.infer<typeof barkConfigSchema>;
