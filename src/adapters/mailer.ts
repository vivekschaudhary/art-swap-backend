import nodemailer from "nodemailer";

/** Outgoing email over SMTP (Mailpit locally, any SMTP relay in production). */
export type Mailer = {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
};

export function createMailer(smtpUrl: string, from: string): Mailer {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(message) {
      await transport.sendMail({ from, ...message });
    },
  };
}
