import nodemailer, { type Transporter } from 'nodemailer';

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Stable across retries, so receiving systems can recognise a re-sent duplicate. */
  messageId: string;
  headers?: Record<string, string>;
}

export interface MailResult {
  messageId: string;
  response: string;
}

/** Thrown for failures retrying cannot fix (SMTP 5xx, e.g. mailbox rejected). */
export class PermanentMailError extends Error {}

export interface Mailer {
  send(email: OutgoingEmail): Promise<MailResult>;
  verify(): Promise<boolean>;
}

/** SMTP via Nodemailer (Mailpit locally; any SMTP provider via the same settings). */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    opts: { host: string; port: number; secure: boolean; user?: string; password?: string; timeoutMs: number },
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      ...(opts.user ? { auth: { user: opts.user, pass: opts.password ?? '' } } : {}),
      connectionTimeout: opts.timeoutMs,
      greetingTimeout: opts.timeoutMs,
      socketTimeout: opts.timeoutMs,
    });
  }

  async send(email: OutgoingEmail): Promise<MailResult> {
    try {
      const info = await this.transport.sendMail({
        from: this.from,
        to: email.to,
        subject: email.subject,
        text: email.text,
        html: email.html,
        messageId: email.messageId,
        headers: email.headers,
      });
      return { messageId: info.messageId, response: String(info.response ?? '') };
    } catch (err) {
      const code = (err as { responseCode?: number }).responseCode;
      if (code && code >= 500 && code < 600) throw new PermanentMailError(`SMTP ${code}: ${(err as Error).message}`);
      throw err; // connection errors, 4xx: transient
    }
  }

  async verify(): Promise<boolean> {
    try {
      return await this.transport.verify();
    } catch {
      return false;
    }
  }
}
