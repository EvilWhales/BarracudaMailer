# Barracuda Mailer3 Pro (Version 3.0)

**Barracuda Mailer3 Pro v3.0** — advanced Node.js platform for multi-channel mass messaging: email, SMS, push notifications, Telegram, WhatsApp, WeChat. Features web interface, Telegram logs, analytics and enhanced security.

## New Features in v3.0
- **Multi-Channel Sending**:
  - **Telegram**: Bot API for direct messaging and group broadcasts.
  - **WhatsApp**: Twilio API integration for business messaging.
  - **WeChat**: Official API support for enterprise accounts.
  - **Push Notifications**: Firebase Cloud Messaging (FCM) for iOS/Android.
- **Telegram Logs**: Real-time campaign logs and alerts via Telegram bot.
- **Web Interface**: Express.js dashboard for campaign management, analytics, and scheduling.
- **Advanced Analytics**: Delivery tracking, open rates, click rates via SMTP APIs.
- **Scheduling**: Cron-based automated campaigns.
- **Enhanced Security**: Server-side license validation, CAPTCHA verification, encrypted logs.

## Installation
```bash
npm install nodemailer handlebars puppeteer twilio firebase-admin @grammyjs/grammy axios express node-cron
```

## Configuration
- **.env**:
  ```
  TELEGRAM_BOT_TOKEN=your-bot-token
  WHATSAPP_TWILIO_SID=your-sid
  WECHAT_APP_ID=your-app-id
  FCM_KEY=path/to/fcm-key.json
  ```
- **config.js**: Enable modules (`messaging.telegram.enabled: true`).

## Launch
- CLI: `node index.js`.
- Web: `http://localhost:3000/dashboard`.