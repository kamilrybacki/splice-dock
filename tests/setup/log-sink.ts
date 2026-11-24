import { setLogSink } from '../../src/common/logger.js';
import { stdoutLogSink } from '../../src/stdout-log-sink.js';

// Mirror the composition root: logs go to stdout so tests can capture them.
setLogSink(stdoutLogSink);
