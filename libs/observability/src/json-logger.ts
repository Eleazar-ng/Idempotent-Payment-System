import type { LoggerService } from '@nestjs/common';
import { currentRequestId } from './request-context';
import { redact, scrubText } from './redact';

export type LogLevel = 'debug' | 'log' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 0, log: 1, warn: 2, error: 3 };
const NAME: Record<LogLevel, string> = { debug: 'debug', log: 'info', warn: 'warn', error: 'error' };

export function parseLogLevel(value: string | undefined): LogLevel {
  switch (value) {
    case 'debug':
      return 'debug';
    case 'warn':
      return 'warn';
    case 'error':
      return 'error';
    default:
      return 'log';
  }
}

export interface JsonLoggerOptions {
  level?: LogLevel;
  /** Where lines go. Default: stdout. Tests capture them. */
  write?: (line: string) => void;
  now?: () => Date;
  service?: string;
}

/**
 * One JSON object per line, with the request id on every line written while a request is being handled,
 * and secrets removed before anything is written. Replaces Nest's default logger so that what operators
 * search (`requestId`, `level`, `context`) is a field, not a position in a sentence.
 */
export class JsonLogger implements LoggerService {
  private readonly level: LogLevel;
  private readonly write: (line: string) => void;
  private readonly now: () => Date;
  private readonly service: string | undefined;

  constructor(options: JsonLoggerOptions = {}) {
    this.level = options.level ?? 'log';
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.now = options.now ?? (() => new Date());
    this.service = options.service;
  }

  log(message: unknown, ...rest: unknown[]): void {
    this.emit('log', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.emit('warn', message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.emit('error', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.emit('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.emit('debug', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.emit('error', message, rest);
  }

  private emit(level: LogLevel, message: unknown, rest: unknown[]): void {
    if (ORDER[level] < ORDER[this.level]) return;

    // Nest passes the logger's context name as the last string argument.
    let context: string | undefined;
    const extras = [...rest];
    if (extras.length > 0 && typeof extras[extras.length - 1] === 'string') context = extras.pop() as string;

    const entry: Record<string, unknown> = {
      time: this.now().toISOString(),
      level: NAME[level],
      ...(this.service ? { service: this.service } : {}),
      ...(context ? { context } : {}),
      ...(currentRequestId() ? { requestId: currentRequestId() } : {}),
    };
    if (message !== null && typeof message === 'object' && !(message instanceof Error)) {
      Object.assign(entry, redact(message) as object, { level: NAME[level], time: entry.time });
    } else if (message instanceof Error) {
      entry.message = scrubText(message.message);
      entry.error = redact(message);
    } else {
      entry.message = scrubText(String(message));
    }
    if (extras.length > 0) entry.detail = redact(extras.length === 1 ? extras[0] : extras);

    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({ time: entry.time, level: NAME[level], message: '[unserialisable log entry]' });
    }
    this.write(line);
  }
}
