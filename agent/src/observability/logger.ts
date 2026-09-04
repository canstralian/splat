/**
 * Minimal structured logger. Emits single-line JSON so logs are queryable in
 * Workers Logs / Logpush. Never log secrets; callers pass already-redacted data.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  runId?: string;
  sessionId?: string;
  stage?: string;
  [key: string]: unknown;
}

export class Logger {
  constructor(private readonly base: LogContext = {}) {}

  child(extra: LogContext): Logger {
    return new Logger({ ...this.base, ...extra });
  }

  private emit(level: LogLevel, message: string, fields?: LogContext): void {
    const line = {
      level,
      message,
      ts: new Date().toISOString(),
      ...this.base,
      ...fields,
    };
    const serialized = JSON.stringify(line);
    if (level === "error") console.error(serialized);
    else if (level === "warn") console.warn(serialized);
    else console.log(serialized);
  }

  debug(message: string, fields?: LogContext): void {
    this.emit("debug", message, fields);
  }
  info(message: string, fields?: LogContext): void {
    this.emit("info", message, fields);
  }
  warn(message: string, fields?: LogContext): void {
    this.emit("warn", message, fields);
  }
  error(message: string, fields?: LogContext): void {
    this.emit("error", message, fields);
  }
}
