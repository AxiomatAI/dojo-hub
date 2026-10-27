import pino from 'pino';

export function createLogger(level: string, pretty: boolean) {
  return pino({
    level,
    base: { service: 'dojohub' },
    redact: ['req.headers.authorization', 'req.headers.cookie', '*.apiKey', '*.password', '*.secret'],
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  });
}
export type Logger = ReturnType<typeof createLogger>;
