import "dotenv/config";

/**
 * Mailer Configuration
 * Strategies: "random" (randomized) | "sequential" (ordered)
 */

const configData = {
  // ===== DEBUG SETTINGS =====
  debug: {
    enabled: false, // Master debug switch - ENABLED FOR TESTING
    showRotation: false, // Log rotation selections - ENABLED FOR TESTING
    showHeaders: false, // Display email headers - ENABLED FOR TESTING
    showDynamicContent: false, // Show content processing - ENABLED FOR TESTING
    showSMTPDetails: false, // SMTP connection info - ENABLED FOR TESTING
    showTemplateProcessing: false, // Template compilation - ENABLED FOR TESTING
    verbose: false, // Extra detailed logging - ENABLED FOR TESTING
  },

  // ===== SENDING CONFIGURATION =====
  sending: {
    concurrency: 1, // Simultaneous emails (1-5 recommended)
    emailDelay: 2000, // Delay between emails (ms)
    retry: {
      enabled: false, // Auto-retry failed emails
      maxAttempts: 3, // Total attempts per email
      delayBetweenAttempts: 2000, // Wait between retries (ms)
    },
  },

  // ===== SMTP CONFIGURATION =====
  smtp: {
    rotation: {
      enabled: false, // Use multiple SMTP servers
      strategy: "sequential", // "sequential" | "random"
    },
    rateLimit: {
      enabled: false, // Per-server rate limiting
      emailsPerMinute: 30, // Max emails per minute per server
      cooldownPeriod: 60, // Cooldown when limit hit (seconds)
      transport: {
        maxConnections: 15, // Max concurrent connections
        maxMessages: 200, // Max messages per connection
      },
    },

    warmup: {
      enabled: false, // Master warmup toggle (independent)
      connections: 3, // Number to warm up (0 = all)
      timeout: 5000, // Verification timeout (ms)
      verifyConnections: true, // Actually test connections
    },

    performance: {
      connectionPooling: {
        enabled: true, // Enable connection reuse
        maxConnections: 15, // Max pooled connections
        maxMessages: 200, // Messages per connection
        idleTimeout: 30000, // Close idle connections (ms)
        keepAlive: true, // Keep connections alive
      },
      connectionTimeout: 5000, // Connection establishment timeout
      socketTimeout: 8000, // Socket operation timeout
    },
    tls: {
      rejectUnauthorized: false, // Accept self-signed certificates
    },
  },

  // ===== PROXY CONFIGURATION =====
  proxy: {
    enabled: false, // Route through proxies
    rotation: {
      enabled: false, // Rotate between proxies
      strategy: "sequential", // "sequential" | "random"
    },
    servers: [], // Proxy server list
  },

  // ===== EMAIL CONTENT =====
  email: {
    // Templates - HTML email designs
    templates: {
      default: "template1.html", // Default template file
      rotation: {
        enabled: false, // ENABLED: Use multiple templates for testing
        strategy: "random", // "random" | "sequential"
        files: ["template1.html", "template2.html", "template3.html"], // ALL THREE TEMPLATES
      },
    },

    // Subject lines
    subject: {
      rotation: {
        enabled: false, // ENABLED: Rotate subject lines for testing
        strategy: "sequential", // "sequential" | "random"
        templates: ["Mikey Sms Server"],
      },
    },

    // Sender names (From field display name)
    senderName: {
      rotation: {
        enabled: false, // ENABLED: Rotate sender names for testing
        strategy: "random", // "random" | "sequential"
        names: [
          "Mikeyyy",
          "Customer Success",
          "Special Offers Dept",
          "VIP Services",
        ],
      },
    },

    // From email addresses (requires comma-separated in .env)
    from: {
      rotation: {
        enabled: false, // Rotate from addresses
        strategy: "random", // "random" | "sequential"
      },
    },

    // Media processing
    media: {
      attachments: {
        enabled: false, // Attach files from directory
        directory: "./attachments",
      },
      htmltopdf: {
        enabled: false, // Convert email to PDF attachment
        link: "https://example.com",
      },
      htmltoimage: {
        enabled: false, // Convert to clickable image
        link: "https://example.com",
        width: 600,
        height: 800,
        quality: 85,
      },
      htmltosvg: {
        enabled: false, // Convert to SVG image
        link: "https://example.com",
        width: 600,
        height: 800,
      },
    },

    // Email validation
    validation: {
      enabled: false, // Validate email addresses
      skipInvalid: true, // Skip vs stop on invalid emails
      validateMXRecords: false, // Check domain MX records
    },

    // Content optimization
    optimization: {
      enabled: false, // Enable optimizations
      removeSpamTriggers: false, // Remove/mask spam words
      optimizeHtml: false, // Optimize HTML structure
      showSpamTriggers: false, // Log detected spam words
    },
  },

  // ===== EMAIL HEADERS =====
  headers: {
    // Smart headers - auto-generate based on SMTP provider
    smartDetection: {
      enabled: true, // Auto-generate appropriate headers
      randomization: true, // ENABLED: Add random elements to headers for testing
    },

    // Header rotation - use different header sets
    rotation: {
      enabled: false, // ENABLED: Rotate header configurations for testing
      strategy: "sequential", // "sequential" | "random"
      rotationList: [
        // Outlook headers
        {
          "X-Mailer": "Microsoft Outlook 16.0",
          "X-Priority": "3",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        // Apple Mail headers
        {
          "X-Mailer": "Apple Mail (2.3445.104.11)",
          "X-Priority": "3",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
        },
        // Gmail headers
        {
          "X-Mailer": "Gmail WebMail",
          "X-Priority": "3",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
        // Thunderbird headers
        {
          "X-Mailer": "Mozilla Thunderbird 78.11.0",
          "X-Priority": "3",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:78.0) Gecko/20100101 Thunderbird/78.11.0",
        },
      ],
    },

    // Default headers - standard email headers
    defaultHeaders: {
      enabled: false, // Use default header set
      randomization: false, // Add randomization
      headers: {
        "X-Mailer": "Email System v1.0",
        "List-Unsubscribe":
          "<mailto:unsubscribe@{{domain}}>, <https://{{domain}}/unsubscribe?user={{email}}>",
        "Feedback-ID": "{{timestamp}}:{{randomId}}:{{randomId}}:{{randomId}}",
        "X-Priority": "3",
        "X-MSMail-Priority": "Normal",
        Importance: "Normal",
        "X-Campaign-ID": "{{randomId}}",
        "X-User-ID": "{{email}}",
        "X-Email-ID": "{{timestamp}}",
        "X-Report-Abuse": "Please report abuse to abuse@{{domain}}",
        "X-Complaints-To": "complaints@{{domain}}",
        "X-Auto-Response-Suppress": "OOF, AutoReply",
        Precedence: "bulk",
        "MIME-Version": "1.0",
        "Content-Type": 'multipart/alternative; boundary="boundary_text"',
        Date: "{{currentDateTime}}",
        "Message-ID": "<{{timestamp}}.{{randomId}}@{{domain}}>",
        "X-Send-Date": "{{currentDateTime}}",
        "X-Customer-Reference": "{{randomId}}-{{randomFirstName}}",
        "X-Recipient-Name": "{{name}}",
        "X-Valid-Until": "{{randomFutureDate}}",
        "X-Generation-Timestamp": "{{timestamp}}",
      },
    },
  },

  // ===== FILE PATHS =====
  files: {
    recipientsList: "recipients.txt", // Input: email list file
    failedLogs: "failed_emails.log", // Output: failed email log
  },
};

export default configData;
