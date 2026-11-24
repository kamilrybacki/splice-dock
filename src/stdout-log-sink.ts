import type { LogSink } from './common/logger.js';

/** Default destination: JSON lines on stdout. Resolves process.stdout per call so it can be redirected. */
export const stdoutLogSink: LogSink = line => {
  process.stdout.write(line);
};
