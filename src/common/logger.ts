export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  request_id?: string;
  tool?: string;
  profile?: string;
  driver?: string;
  duration_ms?: number;
  error?: string;
  [key: string]: unknown;
}

function write(level: Level, message: string, fields: LogFields = {}): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export const logger = {
  debug: (message: string, fields?: LogFields) => write('debug', message, fields),
  info:  (message: string, fields?: LogFields) => write('info',  message, fields),
  warn:  (message: string, fields?: LogFields) => write('warn',  message, fields),
  error: (message: string, fields?: LogFields) => write('error', message, fields),
};
