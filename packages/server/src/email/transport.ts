/**
 * Email transport abstraction.
 *
 * Provides a SendEmailFn interface and two implementations:
 *   - A nodemailer-backed sender when SMTP_URL is configured.
 *   - A logging stub when SMTP_URL is empty (dev mode).
 *
 * Inject SendEmailFn via dependency injection so tests can use a fake.
 * Route handlers resolve the transport from config + pass it to service functions.
 */

import nodemailer from 'nodemailer';
import type { Env } from '../config/env.js';
import { getLogger } from '../logging.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface SendEmailArgs {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * A function that sends an email. Async; resolves when the message is accepted
 * (or logged, in dev mode). Rejects on transport errors.
 */
export type SendEmailFn = (args: SendEmailArgs) => Promise<void>;

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

/**
 * Returns the appropriate email transport for the given config:
 *   - If SMTP_URL is empty: returns a stub that logs the email to the logger at
 *     `info` level (does NOT send). This is the dev-mode fallback.
 *   - Otherwise: returns a nodemailer-backed sender using the SMTP_URL.
 *
 * Inject this function's return value wherever emails need to be sent.
 * Tests pass a vitest spy instead.
 */
export function getRealEmailTransport(config: Pick<Env, 'SMTP_URL' | 'SMTP_FROM'>): SendEmailFn {
  if (config.SMTP_URL === '') {
    // Dev-mode stub: log instead of sending.
    return async (args: SendEmailArgs): Promise<void> => {
      getLogger().info(
        { to: args.to, subject: args.subject },
        'Email not sent — SMTP disabled',
      );
    };
  }

  // Production: nodemailer-backed SMTP sender.
  // Create the transporter lazily on first send, not at module load time, so
  // the transport doesn't hold open connections during startup before the first
  // email is sent.
  let transporter: ReturnType<typeof nodemailer.createTransport> | undefined;

  function getTransporter(): ReturnType<typeof nodemailer.createTransport> {
    if (transporter === undefined) {
      transporter = nodemailer.createTransport(config.SMTP_URL);
    }
    return transporter;
  }

  return async (args: SendEmailArgs): Promise<void> => {
    const from = config.SMTP_FROM !== '' ? config.SMTP_FROM : undefined;
    await getTransporter().sendMail({
      from,
      to: args.to,
      subject: args.subject,
      text: args.text,
      ...(args.html !== undefined ? { html: args.html } : {}),
    });
  };
}
