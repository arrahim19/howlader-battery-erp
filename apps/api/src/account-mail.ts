import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import nodemailer from "nodemailer";

@Injectable()
export class AccountMailService {
  configured() {
    return Boolean(
      process.env.SMTP_HOST &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASSWORD &&
      process.env.SMTP_FROM,
    );
  }

  async send(to: string, subject: string, text: string) {
    if (!this.configured())
      throw new ServiceUnavailableException(
        "Email delivery is not configured. Ask the shop administrator to configure SMTP.",
      );
    const port = Number(process.env.SMTP_PORT ?? 465);
    if (![465, 587].includes(port))
      throw new ServiceUnavailableException("Invalid SMTP port configuration.");
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      requireTLS: true,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      logger: false,
      debug: false,
    });
    try {
      await transport.sendMail({
        from: process.env.SMTP_FROM,
        to,
        subject,
        text,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    } finally {
      transport.close();
    }
  }
}
