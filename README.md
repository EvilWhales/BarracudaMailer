## Barracuda Mailer v2.2 (Public Version) - v3 Pro (Community RProxy LAB)

<div align="center">
<img src="https://github.com/user-attachments/assets/dd50388a-a30f-4018-b0c7-48561fc7f19f" />
</div>

- The mastery of FreeMail — Use popular services like Gmail, like SMTP, to send HTML templates multiple times with amazing accuracy. Yes, even for complex projects with high stakes.
- Multi—Account Rotation - Deploy multiple Gmail accounts in a consistent manner, automatically alternating them so that everything runs smoothly, quietly, and smoothly.
- Dynamic Email Topics — Choose from a list of random topic headings to maximize uniqueness and engagement — to enhance uniqueness and reduce spam levels.
- Endless variations of templates — upload a folder with HTML templates and use them endlessly, increasing the originality and extending the life of the sender.
- Hidden Mode — Work quietly in the background, compatible with VPN, while your local computer is running smoothly.
- Randomized delivery times — Increase sender's service life and maximize success rates

https://github.com/user-attachments/assets/413ee0a6-e052-4928-a522-0fda75d4864c

### Adaptive speed limit (fixes WinError 10060 error)
When testing a large number of SMTP accounts, the connection may timeout after a series of authentication attempts. Version 2.0 introduces adaptive rate limiting to prevent PROVIDER blockages and connection timeouts.:

Configurable authentication delays (default is 20-35 seconds)
Exponential delay retry strategy
An automatic circuit breaker that suspends the operation of repeatedly faulty accounts to avoid blockages
Real-time terminal control panel with account status information and recovery timers
Automatic timeouts detection and dynamic delay scaling
New environment variables:
AUTH_DELAY_MIN=20
AUTH_DELAY_MAX=35
MAX_AUTH_RETRIES=3
CIRCUIT_BREAKER_THRESHOLD=3
ADAPTIVE_DELAY_ENABLED=true

### Template modification and personalization.
Deliver more relevant messages and test options safely:

Dynamic content visualization and controlled synonym substitution for natural variation
Obfuscating email templates with unique spaces that make each email unique
Shuffle sections to create multiple permutations of templates for A/B testing
Unique visualization for each message to help test deliverability and measure engagement
Time jitter and personalization markers to make sending more natural and relevant

### Multi-SMTP and load balancing.
Secure scaling between multiple SMTP accounts:

Rotating accounts with load balancing and automatic failover
Authentication and quarantine for bad accounts
Daily sending limits for each account and usage tracking
Automatic retries and fault tolerance in case of connection problems

### Deliverability and control tools to
help campaigns run smoothly and with respect for recipients:

Customizable dispatch windows (by time zone or schedule)
Randomized delays between shipments to avoid predictable patterns
Internet connection monitoring before sending
Automated archiving of invalid/erroneous recipients and reliable logging

### Developer-friendly setup
. Quick installation and configuration:

Requirements: pip install python-dotenv dnspython beautifulsoup4
Copy the .env.example to .env and add the SMTP credentials and settings.
Do a trial run to view the template options before submitting: python test_obfuscation.py
Run the mail client: python mailer.py

### Improved error handling

Failed shipments are automatically moved to invalid_recipients.csv so that the mail client can continue processing.
Constant monitoring of failed SMTP login attempts bad_accounts.txt
Built-in retry system and a setup checker to check the configuration before shipping

<div align="center">
<img src="https://github.com/user-attachments/assets/7ebf05f7-08e1-4abc-ac37-0eaae03101a5" />
</div>

### Safety and compliance

Supports Gmail, Outlook, and other SMTP providers.
Included is the SPF/DKIM/DMARC configuration guide
.env is excluded from version control; never commit credentials
Designed only for mailing by email with permission — include unsubscribe links and follow applicable laws

## Ethical Use
Barracuda Mailer is for authorized security testing only. Unauthorized use may violate laws such as the Computer Fraud and Abuse Act (CFAA) or local cybersecurity regulations. Always obtain explicit permission from system owners before testing.

## Community and Support
Join our community for discussions and support:
- [Discord Server](https://subscord.com/store/1397884713951170610/checkout/r14cUB69-Nzgw)

### Contributing
Contributions are welcome! If you have ideas for improving configurations or adding new templates, please submit a pull request. Ensure all contributions align with the educational and ethical goals of this project.

### License
Licensed under the MIT License for educational and authorized security testing purposes only. See LICENSE for details.
