# Installation of Barracuda MailerV2 (Version 2.2)

## Requirements
- **Node.js**: Version ≥12 (download from [nodejs.org](https://nodejs.org)).
- **Operating System**: Windows, Linux, macOS.
- **Folder Structure**:
  - `attachments`: For email attachments.
  - `macros`: For macros (optional).
  - `.cache`: For caching.

## Install Dependencies
1. Clone or extract the project to a directory (e.g., `C:\BarracudaMailerV2`).
2. Install dependencies:
   ```bash
   npm install nodemailer handlebars puppeteer chalk
   ```
3. Create required folders:
   ```bash
   mkdir attachments
   mkdir attachments/.cache
   mkdir macros
   ```

## Set Up a Custom SMTP Server
1. **Postfix (Linux)**:
   - Install Postfix:
     ```bash
     sudo apt update
     sudo apt install postfix
     ```
   - Configure `/etc/postfix/main.cf`:
     ```
     myhostname = your-domain.com
     mydestination = $myhostname, localhost
     relayhost =
     smtpd_tls_cert_file=/etc/ssl/certs/your-cert.pem
     smtpd_tls_key_file=/etc/ssl/private/your-key.pem
     smtpd_use_tls=yes
     ```
   - Generate SSL certificates:
     ```bash
     sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout /etc/ssl/private/your-key.pem -out /etc/ssl/certs/your-cert.pem
     ```
   - Restart Postfix:
     ```bash
     sudo systemctl restart postfix
     ```
2. **hMailServer (Windows)**:
   - Download from [hmailserver.com](https://www.hmailserver.com).
   - Install and configure domain, accounts, SMTP (port 25, TLS).
   - Open port 25 in firewall:
     ```cmd
     netsh advfirewall firewall add rule name="SMTP" dir=in action=allow protocol=TCP localport=25
     ```
3. **Test SMTP**:
   - Verify sending:
     ```bash
     echo "Test" | mail -s "Test Email" test@example.com
     ```

## Free SMTP Services
- **Brevo**:
  - Sign up: [brevo.com](https://www.brevo.com).
  - Limit: 300 emails/day (free).
  - SMTP: `smtp-relay.brevo.com`, port 587, TLS.
- **SendGrid**:
  - Sign up: [sendgrid.com](https://sendgrid.com).
  - Limit: 100 emails/day (free).
  - SMTP: `smtp.sendgrid.net`, port 587, TLS.
- **Mailjet**:
  - Sign up: [mailjet.com](https://www.mailjet.com).
  - Limit: 200 emails/day (free).
  - SMTP: `in-v3.mailjet.com`, port 587, TLS.
- **Amazon SES**:
  - Sign up: [aws.amazon.com/ses](https://aws.amazon.com/ses).
  - Limit: 200 emails/day (free for 1 year).
  - SMTP: `email-smtp.<region>.amazonaws.com`, port 587, TLS.

  # Configuration of Barracuda MailerV2 (Version 2.2)

## File Setup

### 1. `.env`
Create `.env` in the project root:
```
SMTP_HOST_1=smtp-relay.brevo.com
SMTP_PORT_1=587
SMTP_SECURE_1=true
SMTP_USER_1=your-email@domain.com
SMTP_PASS_1=your-smtp-key
SMTP_FROM_1=your-email@domain.com
```
- **SMTP_HOST_1**: SMTP server host (e.g., `smtp-relay.brevo.com` or `localhost` for custom server).
- **SMTP_USER_1**, **SMTP_PASS_1**: SMTP credentials (from Brevo, SendGrid, Mailjet, or custom server).
- **SMTP_FROM_1**: Sender email.

### 2. `config.js`
Configure settings in `config.js`:
```javascript
module.exports = {
  sending: {
    concurrency: 1, // Simultaneous sends (1-5)
    emailDelay: 2000, // Delay between emails (ms)
    retry: { enabled: true, maxAttempts: 3, delayBetweenAttempts: 5000 }
  },
  smtp: {
    warmup: { enabled: true }, // Connection warmup
    rotation: { enabled: false } // SMTP server rotation
  },
  email: {
    templates: {
      default: "template1.html",
      rotation: { enabled: true, files: ["template1.html"] }
    },
    subject: { rotation: { enabled: true, templates: ["Offer 1"] } },
    senderName: { rotation: { enabled: true, names: ["Sender"] } },
    optimization: { enabled: true, showSpamTriggers: true }, // Spam optimization
    media: { htmltopdf: { enabled: true }, attachments: { enabled: false } } // PDF and attachments
  },
  debug: { enabled: true, showSMTPDetails: true, showRotation: true } // Logs
};
```

### 3. `recipients.txt`
Create `recipients.txt` with emails or phone numbers (for SMS via SMTP gateway):
```
test@example.com,Evil,Whales
+12345678976@sms.att.net
```

### 4. Templates
Create `template1.html` in the project root:
```html
<p>Hello {{firstName}}! Check our offer!</p>
```

## SMTP Configuration
### Custom SMTP
- **Postfix (Linux)**:
  - Ensure port 25 is open:
    ```bash
    sudo ufw allow 25
    ```
  - Check status:
    ```bash
    sudo systemctl status postfix
    ```
  - In `.env`:
    ```
    SMTP_HOST_1=localhost
    SMTP_PORT_1=25
    SMTP_SECURE_1=false
    SMTP_USER_1=your-user
    SMTP_PASS_1=your-password
    ```
- **hMailServer (Windows)**:
  - Configure domain and account in hMailServer.
  - In `.env`:
    ```
    SMTP_HOST_1=localhost
    SMTP_PORT_1=25
    SMTP_SECURE_1=false
    SMTP_USER_1=your-user@your-domain.com
    SMTP_PASS_1=your-password
    ```

### Free SMTP Services
1. **Brevo**:
   - Sign up at [brevo.com](https://www.brevo.com).
   - Get API key and SMTP credentials.
   - In `.env`:
     ```
     SMTP_HOST_1=smtp-relay.brevo.com
     SMTP_PORT_1=587
     SMTP_SECURE_1=true
     SMTP_USER_1=your-email@domain.com
     SMTP_PASS_1=your-brevo-key
     SMTP_FROM_1=your-email@domain.com
     ```
2. **SendGrid**:
   - Sign up at [sendgrid.com](https://sendgrid.com).
   - Get API key and SMTP credentials.
   - In `.env`:
     ```
     SMTP_HOST_1=smtp.sendgrid.net
     SMTP_PORT_1=587
     SMTP_SECURE_1=true
     SMTP_USER_1=apikey
     SMTP_PASS_1=your-sendgrid-key
     SMTP_FROM_1=your-email@domain.com
     ```
3. **Mailjet**:
   - Sign up at [mailjet.com](https://www.mailjet.com).
   - Get SMTP credentials.
   - In `.env`:
     ```
     SMTP_HOST_1=in-v3.mailjet.com
     SMTP_PORT_1=587
     SMTP_SECURE_1=true
     SMTP_USER_1=your-mailjet-key
     SMTP_PASS_1=your-mailjet-secret
     SMTP_FROM_1=your-email@domain.com
     ```
4. **Amazon SES**:
   - Sign up at [aws.amazon.com/ses](https://aws.amazon.com/ses).
   - Create SMTP credentials in AWS console.
   - In `.env`:
     ```
     SMTP_HOST_1=email-smtp.us-east-1.amazonaws.com
     SMTP_PORT_1=587
     SMTP_SECURE_1=true
     SMTP_USER_1=your-ses-key
     SMTP_PASS_1=your-ses-secret
     SMTP_FROM_1=your-email@domain.com
     ```

## Launch
- Windows: `sendEmails.bat`
- Linux/macOS:
  ```bash
  node index.js
  ```

## Troubleshooting
  - Create files or update `config.js`:
    ```javascript
    email: { templates: { rotation: { files: ["template5.html"] } } }
    ```
- **Directory error** (`ENOENT: attachments\.cache`):
  - Create:
    ```bash
    mkdir attachments/.cache
    ```
- **Empty recipient list**:
  - Add valid emails/phone numbers to `recipients.txt`.

## Monitoring
- Enable `debug.enabled` in `config.js` for detailed logs.
- Check `failed_emails.log` for errors.

## Notes
- **SMS**: Requires an operator’s SMTP gateway (e.g., MTS). If unavailable, consider API services (Twilio, SMS.to).
- **Limits**: Adhere to free SMTP limits (Brevo: 300 emails/day, SendGrid: 100 emails/day).