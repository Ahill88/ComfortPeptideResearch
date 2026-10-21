import { Logger } from '@nestjs/common';
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { domainOf } from '../email.validation';
import type { EmailProvider, OutboundEmail, SendResult } from '../email.provider';

export const MAX_DEV_FILES = 200;

export interface ConsoleProviderOptions {
  /** Development/test only (decided by loadEmailConfig). When false NOTHING is written to disk. */
  devFiles: boolean;
  dir: string;
  maxFiles?: number;
}

/**
 * Development/test transport. Logs ONE redacted line per message (template, recipient domain, outbox id; never the address, the
 * subject or any body text). When `devFiles` is on it also writes the full rendered message to `<dir>/<id>.txt` so a developer
 * can open verification and reset links; the directory is private (0700), files 0600, and only the newest `maxFiles` are kept.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';
  private readonly logger = new Logger('EmailConsole');

  constructor(private readonly options: ConsoleProviderOptions) {}

  async send(message: OutboundEmail): Promise<SendResult> {
    this.logger.log(`email template=${message.template} toDomain=${domainOf(message.to)} id=${message.id}`);
    if (this.options.devFiles) this.writeDevFile(message);
    return { ok: true, providerMessageId: `console:${message.id}` };
  }

  private writeDevFile(message: OutboundEmail): void {
    try {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(message.id)) throw new Error('unsafe id');
      if (!existsSync(this.options.dir)) mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
      const file = join(this.options.dir, `${message.id}.txt`);
      writeFileSync(file, `To: ${message.to}\nSubject: ${message.subject}\nTemplate: ${message.template}\n\n${message.text}`, { mode: 0o600 });
      chmodSync(file, 0o600);
      this.rotate();
    } catch {
      // The line above already reported the message; a dev-file problem must never fail or leak anything.
      this.logger.warn(`email dev file for id=${message.id} could not be written`);
    }
  }

  private rotate(): void {
    const max = this.options.maxFiles ?? MAX_DEV_FILES;
    const files = readdirSync(this.options.dir)
      .filter((name) => /^[A-Za-z0-9_-]{1,64}\.txt$/.test(name))
      .map((name) => ({ name, mtime: statSync(join(this.options.dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
    for (const old of files.slice(max)) unlinkSync(join(this.options.dir, old.name));
  }
}
