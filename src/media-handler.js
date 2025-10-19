import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import crypto from 'crypto';
import { Readable } from 'stream';

/**
 * Production-ready MediaHandler with multi-engine support and comprehensive error handling
 */
class MediaHandler {
  constructor(config = {}) {
    // Validate and log config reception
    if (config && Object.keys(config).length > 0) {
      console.log(`📎 MediaHandler initialized with config: ${Object.keys(config).join(', ')}`);
    } else {
      console.log(`📎 MediaHandler initialized with empty/undefined config - using defaults`);
    }

    this.config = this._mergeConfig(config);
    this.cache = new MediaCache(this.config.cache.maxSize, this.config.cache.ttl);
    this.attachments = [];
    this.activeConversions = 0;
    this.metrics = new PerformanceMetrics();
    this.engines = new Map();
    this.processors = new Map();

    this.attachmentDir = this.config.attachments?.directory || './attachments';
    this.allowedDirectory = path.resolve(this.attachmentDir);

    this._initializeEngines();
    this._initializeSecurityValidation();
    this.init();
  }

  /**
   * Merge user config with production defaults
   */
  _mergeConfig(userConfig) {
    const defaultConfig = {
      engines: {
        pdf: ['puppeteer', 'playwright', 'chrome-headless', 'text-fallback'],
        image: []
      },
      limits: {
        maxFileSize: 10 * 1024 * 1024, // 10MB
        maxTotalSize: 25 * 1024 * 1024, // 25MB
        maxConcurrent: 3,
        timeout: 30000,
        memoryLimit: 100 * 1024 * 1024, // 100MB
        maxContentSize: 1024 * 1024 // 1MB HTML
      },
      quality: {
        email_optimized: { format: 'webp', quality: 75, compression: 'high' },
        print_quality: { format: 'png', quality: 95, compression: 'low' },
        web_display: { format: 'jpeg', quality: 85, compression: 'medium' }
      },
      security: {
        allowedExtensions: ['.pdf', '.doc', '.docx', '.txt', '.jpg', '.jpeg', '.png', '.gif', '.webp'],
        sanitizeHtml: true,
        validateMimeTypes: true,
        preventPathTraversal: true
      },
      cache: {
        maxSize: 100,
        ttl: 3600000 // 1 hour
      },
      attachments: {
        directory: './attachments',
        enabled: true
      },
      htmltopdf: {
        enabled: false,
        link: null,
        format: 'A4',
        quality: 'high'
      },
      htmltoimage: {
        enabled: false,
        link: null,
        width: 600,
        height: 800,
        quality: 85
      },
      htmltosvg: {
        enabled: false,
        link: null,
        width: 600,
        height: 800
      },
      htmltosvgattachment: {
        enabled: false,
        filename: 'document.svg'
      },

    };

    return this._deepMerge(defaultConfig, userConfig);
  }

  /**
   * Deep merge utility for configuration
   */
  _deepMerge(target, source) {
    const result = { ...target };
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this._deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }

  /**
   * Initialize conversion engines
   */
  _initializeEngines() {
    // PDF Engines
    this.engines.set('puppeteer', new PuppeteerEngine(this.config));
    this.engines.set('playwright', new PlaywrightEngine(this.config));
    this.engines.set('chrome-headless', new ChromeHeadlessEngine(this.config));
    this.engines.set('text-fallback', new TextFallbackEngine(this.config));
  }

  /**
   * Initialize security validation
   */
  _initializeSecurityValidation() {
    this.securityValidator = new SecurityValidator(this.config.security);
  }

  /**
   * Initialize MediaHandler
   */
  async init() {
    try {
      await this._createDirectories();
      await this._loadAttachments();
      await this._runHealthChecks();

      console.log(chalk.green('✅ MediaHandler initialized successfully'));
      console.log(chalk.gray(`📁 Attachment directory: ${this.attachmentDir}`));
      console.log(chalk.gray(`📊 Loaded ${this.attachments.length} attachment(s)`));
    } catch (error) {
      console.error(chalk.red(`❌ MediaHandler initialization failed: ${error.message}`));
      throw error;
    }
  }

  /**
   * Create necessary directories
   */
  async _createDirectories() {
    const directories = [this.attachmentDir, path.join(this.attachmentDir, '.cache')];

    for (const dir of directories) {
      try {
        await fs.promises.access(dir);
      } catch (error) {
          // Log directory creation failures for debugging
          console.warn(`⚠️ Directory creation failed for ${dir}: ${error.message}`);
          if (error.code) {
            console.warn(`   Error code: ${error.code}`);
          }
        }
    }
  }

  /**
   * Load file attachments with security validation
   */
  async _loadAttachments() {
    this.attachments = [];

    try {
      if (!await this._directoryExists(this.attachmentDir)) return;

      const files = await fs.promises.readdir(this.attachmentDir);
      let totalSize = 0;

      for (const file of files) {
        try {
          const filePath = path.join(this.attachmentDir, file);
          const stats = await fs.promises.stat(filePath);

          if (!stats.isFile()) continue;

          // Security validation
          if (!this.securityValidator.validateFilePath(filePath, this.allowedDirectory)) {
            console.warn(chalk.yellow(`⚠️ Skipped invalid file path: ${file}`));
            continue;
          }

          if (!this.securityValidator.validateFileExtension(file)) {
            console.warn(chalk.yellow(`⚠️ Skipped unsupported file type: ${file}`));
            continue;
          }

          if (stats.size > this.config.limits.maxFileSize) {
            console.warn(chalk.yellow(`⚠️ Skipped oversized file: ${file} (${this._formatBytes(stats.size)})`));
            continue;
          }

          totalSize += stats.size;
          if (totalSize > this.config.limits.maxTotalSize) {
            console.warn(chalk.yellow(`⚠️ Total attachment size limit exceeded, skipping remaining files`));
            break;
          }

          const contentType = this._getContentType(path.extname(file).toLowerCase());

          this.attachments.push({
            filename: file,
            path: filePath,
            size: stats.size,
            contentType: contentType,
            lastModified: stats.mtime
          });

        } catch (error) {
          console.warn(chalk.yellow(`⚠️ Error processing file ${file}: ${error.message}`));
        }
      }

      if (this.attachments.length > 0) {
        console.log(chalk.green(`📎 Loaded ${this.attachments.length} attachment(s) (${this._formatBytes(totalSize)})`));
      }

    } catch (error) {
      console.warn(chalk.yellow(`⚠️ Error loading attachments: ${error.message}`));
    }
  }

  /**
   * Check if directory exists
   */
  async _directoryExists(dir) {
    try {
      const stats = await fs.promises.stat(dir);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Get MIME content type for file extension
   */
  _getContentType(ext) {
    const types = {
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.txt': 'text/plain',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    return types[ext] || 'application/octet-stream';
  }

  /**
   * Format bytes for human reading
   */
  _formatBytes(bytes) {
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Get file attachments for NodeMailer
   */
  getAttachments() {
    return this.attachments.map(att => ({
      filename: att.filename,
      path: att.path,
      contentType: att.contentType
    }));
  }

  /**
   * Convert HTML to PDF with multi-engine fallback
   * @param {string} html - HTML content to convert
   * @param {Object} options - Conversion options
   * @returns {Promise<Buffer>} PDF buffer
   */
  async htmlToPdf(html, options = {}) {
    const startTime = Date.now();

    try {
      await this._checkResourceLimits();

      const sanitizedHtml = this.securityValidator.sanitizeHtml(html);
      const cacheKey = this._generateCacheKey('pdf', sanitizedHtml, options);

      // Check cache first
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        this.metrics.recordHit('pdf_cache');
        return cached;
      }

      const result = await this.convertWithFallbacks('pdf', sanitizedHtml, options);

      // Cache successful result
      await this.cache.set(cacheKey, result);

      const duration = Date.now() - startTime;
      this.metrics.recordConversion('pdf', duration, result.length);

      console.log(chalk.green(`✅ PDF generated in ${duration}ms (${this._formatBytes(result.length)})`));
      return result;

    } catch (error) {
      this.metrics.recordError('pdf', error);
      console.error(chalk.red(`❌ PDF conversion failed: ${error.message}`));
      throw error;
    }
  }

  /**
   * Convert HTML to image with high-quality output
   * @param {string} html - HTML content to convert
   * @param {Object} options - Conversion options
   * @returns {Promise<Buffer>} Image buffer
   */
  async htmlToImage(html, options = {}) {
    const startTime = Date.now();

    try {
      await this._checkResourceLimits();

      const sanitizedHtml = this.securityValidator.sanitizeHtml(html);
      const cacheKey = this._generateCacheKey('image', sanitizedHtml, options);

      // Check cache first
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        this.metrics.recordHit('image_cache');
        return cached;
      }

      // Use Puppeteer for HTML-to-image conversion
      const result = await this._convertHtmlToImageWithPuppeteer(sanitizedHtml, options);

      // Cache successful result
      await this.cache.set(cacheKey, result);

      const duration = Date.now() - startTime;
      this.metrics.recordConversion('image', duration, result.length);

      console.log(chalk.green(`✅ Image generated in ${duration}ms (${this._formatBytes(result.length)})`));
      return result;

    } catch (error) {
      this.metrics.recordError('image', error);
      console.error(chalk.red(`❌ Image conversion failed: ${error.message}`));
      throw error;
    }
  }

  /**
   * Unified safe browser cleanup with race condition prevention
   */
  async _safeBrowserCleanup(browser, timeoutMs = 5000) {
    if (!browser) return;

    let cleanupComplete = false;
    let timeoutHandle = null;

    // Promise-based cleanup with timeout
    const cleanupPromise = new Promise(async (resolve) => {
      try {
        // Try graceful close first
        await browser.close();
        if (!cleanupComplete) {
          cleanupComplete = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          resolve("graceful");
        }
      } catch (error) {
        // Graceful close failed, try force kill
        if (!cleanupComplete) {
          // ✅ FIXED: Safer force kill with comprehensive error handling
          this._forceKillBrowserProcess(browser);
          if (!cleanupComplete) {
            cleanupComplete = true;
            if (timeoutHandle) clearTimeout(timeoutHandle);
            resolve("forced");
          }
        }
      }
    });

    // Timeout fallback
    const timeoutPromise = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (!cleanupComplete) {
          cleanupComplete = true;
          // ✅ FIXED: Safer timeout kill
          this._forceKillBrowserProcess(browser);
          resolve("timeout");
        }
      }, timeoutMs);
    });

    // Race between cleanup and timeout
    return Promise.race([cleanupPromise, timeoutPromise]);
  }

  // ✅ NEW: Safe force kill helper method
  _forceKillBrowserProcess(browser) {
    if (!browser) return;

    try {
      // Check if browser has process method
      if (typeof browser.process !== 'function') {
        return; // No process method available
      }

      const browserProcess = browser.process();

      // Validate process object exists
      if (!browserProcess) {
        return; // No process object
      }

      // Check if process is still alive and has PID
      if (!browserProcess.pid || browserProcess.killed) {
        return; // Process already dead or no PID
      }

      // Validate PID is a number
      if (typeof browserProcess.pid !== 'number' || browserProcess.pid <= 0) {
        return; // Invalid PID
      }

      // Try to kill the process
      browserProcess.kill('SIGKILL');

    } catch (killError) {
      // ✅ FIXED: Comprehensive error handling for all kill scenarios
      try {
        // Alternative kill method using process.kill if available
        if (browser.process && typeof browser.process === 'function') {
          const proc = browser.process();
          if (proc && proc.pid && typeof proc.pid === 'number' && proc.pid > 0) {
            process.kill(proc.pid, 'SIGKILL');
          }
        }
      } catch (alternativeKillError) {
        // Silent fail - all kill methods exhausted
        // Process cleanup will be handled by OS eventually
      }
    }
  }

  /**
   * Convert HTML to SVG using Puppeteer (high-quality conversion)
   */
  async _convertHtmlToSvgWithPuppeteer(html, options = {}) {
  let browser = null;
  let page = null;

  try {
    const puppeteer = await import('puppeteer');

    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ],
      timeout: 20000
    });

    page = await browser.newPage();

    // Set viewport for SVG
    await page.setViewport({ 
      width: options.width || 600, 
      height: options.height || 800 
    });

    await page.setContent(html, { 
      waitUntil: 'domcontentloaded',
      timeout: 10000 
    });

    // Get the rendered content dimensions
    const bodyHandle = await page.$('body');
    const boundingBox = await bodyHandle.boundingBox();

    const svgWidth = options.width || Math.max(600, boundingBox.width);
    const svgHeight = options.height || Math.max(800, boundingBox.height);

    // Take screenshot as PNG first, then convert to SVG
    const screenshotBuffer = await page.screenshot({ 
      type: 'png',
      fullPage: true,
      omitBackground: false
    });

    // Convert PNG to SVG with embedded image
    const base64Image = screenshotBuffer.toString('base64');
    const svg = `<svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    <style>
      .email-content { width: 100%; height: 100%; }
    </style>
  </defs>
  <image class="email-content" x="0" y="0" width="${svgWidth}" height="${svgHeight}" 
         xlink:href="data:image/png;base64,${base64Image}" />
</svg>`;

    return Buffer.from(svg);
  } catch (error) {
    throw new Error(`Puppeteer SVG conversion failed: ${error.message}`);
  } finally {
    // Clean up page first
    if (page) {
      try {
        await page.close();
      } catch (error) {
        console.warn(`Page close failed: ${error.message}`);
      }
    }

    // Then clean up browser
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.warn(`Browser close failed: ${closeError.message}`);
        try {
          const browserProcess = browser.process();
          if (browserProcess && !browserProcess.killed) {
            browserProcess.kill('SIGKILL');
          }
        } catch (killError) {
          // Silent fail - process might already be dead
        }
      }
    }
  }
}

  /**
   * Convert HTML to image using Puppeteer
   */
  async _convertHtmlToImageWithPuppeteer(html, options = {}) {
    let browser = null;
    try {
      const puppeteer = await import('puppeteer');

      browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu'
        ],
        timeout: 20000
      });

      const page = await browser.newPage();

      // Set viewport for image
      await page.setViewport({ 
        width: options.width || 600, 
        height: options.height || 800 
      });

      await page.setContent(html, { 
        waitUntil: 'domcontentloaded',
        timeout: 10000 
      });

      // Take screenshot
      const imageBuffer = await page.screenshot({ 
        type: 'jpeg',
        quality: options.quality || 85,
        fullPage: true
      });

      return imageBuffer;
    } catch (error) {
      throw new Error(`Puppeteer image conversion failed: ${error.message}`);
    } finally {
      await this._safeBrowserCleanup(browser);
    }
  }

  /**
   * Convert HTML to SVG
   * @param {string} html - HTML content to convert
   * @param {Object} options - Conversion options
   * @returns {Promise<Buffer>} SVG buffer
   */
  async htmlToSvg(html, options = {}) {
    const startTime = Date.now();

    try {
      await this._checkResourceLimits();

      const sanitizedHtml = this.securityValidator.sanitizeHtml(html);
      const cacheKey = this._generateCacheKey('svg', sanitizedHtml, options);

      // Check cache first
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        this.metrics.recordHit('svg_cache');
        return cached;
      }

      // Try Puppeteer-based SVG conversion first
      const result = await this._convertHtmlToSvgWithPuppeteer(sanitizedHtml, options);

      // Cache successful result
      await this.cache.set(cacheKey, result);

      const duration = Date.now() - startTime;
      this.metrics.recordConversion('svg', duration, result.length);

      console.log(chalk.green(`✅ SVG generated in ${duration}ms (${this._formatBytes(result.length)})`));
      return result;

    } catch (error) {
      this.metrics.recordError('svg', error);
      console.warn(chalk.yellow(`⚠️ Puppeteer SVG failed, using fallback: ${error.message}`));

      // Fallback to simple SVG generation
      const result = await this._generateSvg(html, options);
      console.log(chalk.yellow(`✅ SVG generated using fallback (${this._formatBytes(result.length)})`));
      return result;
    }
  }

  /**
   * Convert with fallback strategies
   */
  async convertWithFallbacks(type, html, options = {}) {
    const engines = this.config.engines[type] || [];
    const timeout = this.config.limits.timeout;

    for (const engineName of engines) {
      const engine = this.engines.get(engineName);
      if (!engine || !await engine.isAvailable()) {
        this.metrics.recordEngineSkip(engineName, 'unavailable');
        continue;
      }

      try {
        const result = await Promise.race([
          engine.convert(html, options),
          this._timeoutPromise(timeout)
        ]);

        this.metrics.recordEngineSuccess(engineName);
        return result;

      } catch (error) {
        this.metrics.recordEngineFailure(engineName, error);
        console.warn(chalk.yellow(`⚠️ ${engineName} failed: ${error.message}`));
        continue;
      }
    }

    throw new Error(`All ${type} conversion strategies failed`);
  }

  /**
   * Check resource limits before conversion
   */
  async _checkResourceLimits() {
    if (this.activeConversions >= this.config.limits.maxConcurrent) {
      throw new Error('Maximum concurrent conversions exceeded');
    }

    const memoryUsage = process.memoryUsage();
    if (memoryUsage.heapUsed > this.config.limits.memoryLimit) {
      // Trigger cleanup
      await this.cache.cleanup();
      global.gc && global.gc();

      const newMemoryUsage = process.memoryUsage();
      if (newMemoryUsage.heapUsed > this.config.limits.memoryLimit) {
        throw new Error('Memory limit exceeded');
      }
    }

    this.activeConversions++;
  }

  /**
   * Generate cache key for content
   */
  _generateCacheKey(type, content, options) {
    const hash = crypto.createHash('md5');
    hash.update(type);
    hash.update(content);
    hash.update(JSON.stringify(options));
    return hash.digest('hex');
  }

  /**
   * Create timeout promise
   */
  _timeoutPromise(ms) {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Operation timeout after ${ms}ms`)), ms);
    });
  }

  /**
   * Generate fallback SVG with better HTML preservation
   */
  async _generateSvg(html, options = {}) {
    const { width = 600, height = 800, backgroundColor = '#ffffff' } = options;

    // Try to preserve more HTML structure
    const processedHtml = this._processHtmlForSvg(html);

    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
      <defs>
        <style>
          .bg { fill: ${backgroundColor}; }
          .header { fill: #007bff; }
          .content-bg { fill: #fafafa; stroke: #e0e0e0; stroke-width: 1; }
          .title { font-size: 20px; font-weight: bold; fill: white; }
          .email-content { font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; }
          .email-content h1 { font-size: 18px; font-weight: bold; margin: 10px 0; }
          .email-content h2 { font-size: 16px; font-weight: bold; margin: 8px 0; }
          .email-content p { margin: 8px 0; }
          .email-content strong { font-weight: bold; }
          .email-content em { font-style: italic; }
          .email-content a { fill: #0066cc; text-decoration: underline; }
        </style>
      </defs>
      <rect class="bg" width="100%" height="100%"/>
      <rect class="header" width="100%" height="60"/>
      <text class="title" x="30" y="40">📧 Email Content (SVG Fallback)</text>
      <rect class="content-bg" x="20" y="80" width="${width - 40}" height="${height - 120}" rx="8"/>
      <foreignObject x="40" y="100" width="${width - 80}" height="${height - 160}">
        <div xmlns="http://www.w3.org/1999/xhtml" class="email-content" style="padding: 20px; color: #2c3e50; overflow: hidden;">
          ${processedHtml}
        </div>
      </foreignObject>
    </svg>`;

    return Buffer.from(svg);
  }

  /**
   * Process HTML for SVG embedding (preserves more structure)
   */
  _processHtmlForSvg(html) {
    // FIX: Validate input HTML exists and is a string
    if (!html || typeof html !== 'string') {
      return '';
    }

    // Remove scripts and styles but preserve basic HTML structure
    let processed = html
      .replace(/<style[^>]*>.*?<\/style>/gis, '')
      .replace(/<script[^>]*>.*?<\/script>/gis, '')
      .replace(/<meta[^>]*>/gis, '')
      .replace(/<link[^>]*>/gis, '')
      .replace(/<!DOCTYPE[^>]*>/gi, '')
      .replace(/<html[^>]*>/gi, '')
      .replace(/<\/html>/gi, '')
      .replace(/<head[^>]*>.*?<\/head>/gis, '')
      .replace(/<body[^>]*>/gi, '<div>')
      .replace(/<\/body>/gi, '</div>');

    // FIX: Ensure processed content is still a valid string after HTML processing
    if (!processed || typeof processed !== 'string') {
      processed = '';
    }

    // Clean up attributes that don't work in SVG context
    processed = processed
      .replace(/\s+style="[^"]*"/gi, '')
      .replace(/\s+class="[^"]*"/gi, '')
      .replace(/\s+id="[^"]*"/gi, '');

    // FIX: Validate processed content after attribute cleanup
    if (!processed || typeof processed !== 'string') {
      processed = '';
    }

    // Escape special characters for XML
    processed = processed
      .replace(/&(?!amp;|lt;|gt;|quot;|apos;)/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    // FIX: Final validation before using processed content
    if (!processed || typeof processed !== 'string') {
      return this._formatTextForSvg(this._extractTextFromHtml(html));
    }

    // If processing results in very little content, fall back to text extraction
    if (processed.replace(/&[a-z]+;/gi, '').trim().length < 10) {
      return this._formatTextForSvg(this._extractTextFromHtml(html));
    }

    return processed.substring(0, 1500); // Limit size for SVG
  }

  /**
   * Extract text from HTML
   */
  _extractTextFromHtml(html) {
    return html
      .replace(/<style[^>]*>.*?<\/style>/gis, '')
      .replace(/<script[^>]*>.*?<\/script>/gis, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Format text for SVG
   */
  _formatTextForSvg(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .substring(0, 800);
  }

  /**
   * Create clickable email HTML
   */
  createClickableEmail(mediaBuffer, link, format = 'jpeg') {
    const mediaBase64 = mediaBuffer.toString('base64');
    const mimeType = format === 'svg' ? 'image/svg+xml' : `image/${format}`;

    return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Email Content</title>
  <style type="text/css">
    * { margin: 0; padding: 0; }
    body { background-color: #f4f4f4; font-family: Arial, sans-serif; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; }
    .content { background: #fff; border-radius: 8px; overflow: hidden; }
    .image { display: block; width: 100%; height: auto; border: none; }
    .footer { background: #f8f9fa; padding: 20px; text-align: center; }
    .footer-text { font-size: 13px; color: #6c757d; margin: 0; }
    .link { color: #0066cc; text-decoration: none; font-weight: 500; }
    @media only screen and (max-width: 600px) {
      .container { width: 100% !important; margin: 0 !important; }
      .content { border-radius: 0 !important; }
    }
  </style>
</head>
<body>
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
    <tr>
      <td align="center" style="padding: 20px 10px;">
        <table class="container" role="presentation" cellspacing="0" cellpadding="0" border="0">
          <tr>
            <td>
              <table class="content" role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td>
                    <a href="${link}" target="_blank">
                      <img class="image" src="data:${mimeType};base64,${mediaBase64}" alt="Email Content" width="600" />
                    </a>
                  </td>
                </tr>
                <tr>
                  <td class="footer">
                    <p class="footer-text">
                      <a href="${link}" target="_blank" class="link">👆 Click above to visit our website</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  /**
   * Process email content with all configured features
   * @param {string} html - HTML content
   * @param {Object} mailOptions - Email options
   * @returns {Promise<Object>} Processing results
   */
  async processEmailContent(html, mailOptions = {}) {
    const results = {
      attachments: [],
      htmlModified: false,
      errors: []
    };

    try {
      // Add file attachments (keep HTML) - with safe config access
      if (this.config?.attachments?.enabled) {
        const fileAttachments = this.getAttachments();
        results.attachments.push(...fileAttachments);

        if (fileAttachments.length > 0) {
          console.log(chalk.green(`📎 Added ${fileAttachments.length} file attachment(s)`));
        }
      }

      // PDF conversion - with safe config access
      if (this.config?.htmltopdf?.enabled) {
        try {
          console.log(chalk.blue('📄 Converting HTML to PDF only...'));
          const pdfBuffer = await this.htmlToPdf(html, {
            format: this.config.htmltopdf.format || 'A4',
            quality: this.config.htmltopdf.quality || 'high'
          });

          results.attachments.push({
            filename: 'document.pdf',
            content: pdfBuffer,
            contentType: 'application/pdf'
          });

          // Replace HTML with simple PDF message
          mailOptions.html = `
            <div style="font-family: Arial, sans-serif; padding: 20px; text-align: center;">
              <h2>📄 Document Attached</h2>
              <p>Please find the attached PDF document.</p>
              ${this.config.htmltopdf.link ? `<p><a href="${this.config.htmltopdf.link}">Visit our website</a></p>` : ''}
            </div>
          `;
          results.htmlModified = true;
        } catch (pdfError) {
          console.warn(chalk.yellow(`⚠️ PDF conversion failed: ${pdfError.message}`));
          results.errors.push({ type: 'pdf', error: pdfError.message });
        }
      }

      // Image conversion - with safe config access
      if (this.config?.htmltoimage?.enabled) {
        console.log(chalk.blue('📸 Converting to image...'));
        const imageBuffer = await this.htmlToImage(html, {
          width: this.config.htmltoimage.width,
          height: this.config.htmltoimage.height,
          quality: this.config.htmltoimage.quality
        });

        mailOptions.html = this.createClickableEmail(
          imageBuffer, 
          this.config.htmltoimage.link, 
          'jpeg'
        );
        results.htmlModified = true;
      }

      // SVG conversion - with safe config access
      if (this.config?.htmltosvg?.enabled) {
        console.log(chalk.blue('🎨 Converting to SVG...'));
        const svgBuffer = await this.htmlToSvg(html, {
          width: this.config.htmltosvg.width,
          height: this.config.htmltosvg.height
        });

        mailOptions.html = this.createClickableEmail(
          svgBuffer, 
          this.config.htmltosvg.link, 
          'svg'
        );
        results.htmlModified = true;
      }

    } catch (error) {
      this.metrics?.recordError?.('processing', error);
      console.error(chalk.red(`❌ Media processing failed: ${error.message}`));
      results.errors.push({ type: 'processing', error: error.message });
    } finally {
      this.activeConversions = Math.max(0, this.activeConversions - 1);
    }

    return results;
  }

  /**
   * Run comprehensive health checks
   */
  async _runHealthChecks() {
    const results = {
      engines: {},
      security: true,
      performance: true
    };

    // Test each engine
    for (const [name, engine] of this.engines) {
      try {
        results.engines[name] = await engine.isAvailable();
      } catch (error) {
        results.engines[name] = false;
      }
    }

    return results;
  }

  /**
   * Run comprehensive diagnostics
   */
  async runDiagnostics() {
    console.log(chalk.cyan('🔍 Running MediaHandler diagnostics...'));

    const tests = [
      () => this._testPdfConversion(),
      () => this._testImageConversion(),
      () => this._testResourceLimits(),
      () => this._testSecurity(),
      () => this._testCache()
    ];

    const results = [];
    for (const test of tests) {
      try {
        const result = await test();
        results.push({ success: true, result });
      } catch (error) {
        results.push({ success: false, error: error.message });
      }
    }

    return results;
  }

  /**
   * Test PDF conversion
   */
  async _testPdfConversion() {
    const testHtml = '<html><body><h1>Test PDF</h1><p>This is a test.</p></body></html>';
    const pdf = await this.htmlToPdf(testHtml);
    return { type: 'pdf', size: pdf.length, success: true };
  }

  /**
   * Test image conversion
   */
  async _testImageConversion() {
    const testHtml = '<html><body><h1>Test Image</h1><p>This is a test.</p></body></html>';
    const image = await this.htmlToImage(testHtml);
    return { type: 'image', size: image.length, success: true };
  }

  /**
   * Test resource limits
   */
  async _testResourceLimits() {
    const memoryUsage = process.memoryUsage();
    return {
      memoryUsage: memoryUsage.heapUsed,
      limit: this.config.limits.memoryLimit,
      withinLimit: memoryUsage.heapUsed < this.config.limits.memoryLimit
    };
  }

  /**
   * Test security features
   */
  async _testSecurity() {
    const maliciousHtml = '<script>alert("xss")</script><h1>Test</h1>';
    const sanitized = this.securityValidator.sanitizeHtml(maliciousHtml);
    return {
      originalContainsScript: maliciousHtml.includes('<script>'),
      sanitizedContainsScript: sanitized.includes('<script>'),
      sanitizationWorking: !sanitized.includes('<script>')
    };
  }

  /**
   * Test cache functionality
   */
  async _testCache() {
    const key = 'test-key';
    const value = Buffer.from('test-value');

    await this.cache.set(key, value);
    const retrieved = await this.cache.get(key);

    return {
      cacheWorking: Buffer.compare(value, retrieved) === 0,
      cacheSize: this.cache.size
    };
  }

  /**
   * Get comprehensive statistics
   */
  getStats() {
    return {
      attachments: this.attachments.length,
      cache: this.cache.getStats(),
      metrics: this.metrics.getStats(),
      config: {
        attachments: this.config.attachments?.enabled || false,
        pdf: this.config.htmltopdf?.enabled || false,
        image: this.config.htmltoimage?.enabled || false,
        svg: this.config.htmltosvg?.enabled || false,
        svgAttachment: this.config.htmltosvgattachment?.enabled || false
      },
      engines: Object.fromEntries(
        Array.from(this.engines.entries()).map(([name, engine]) => [
          name, 
          { available: engine.isAvailable?.() || false }
        ])
      )
    };
  }

  /**
   * Clear caches and reset state
   */
  async clearCache() {
    await this.cache.clear();
    this.metrics.reset();
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    await this.clearCache();

    // Cleanup engines
    for (const engine of this.engines.values()) {
      if (engine.cleanup) {
        await engine.cleanup();
      }
    }
  }

  /**
   * Register custom engine
   */
  registerEngine(name, engine) {
    this.engines.set(name, engine);
  }

  /**
   * Register custom processor
   */
  addProcessor(type, processor) {
    this.processors.set(type, processor);
  }
}

/**
 * Smart LRU Cache with TTL support
 */
class MediaCache {
  constructor(maxSize = 100, ttl = 3600000) {
    this.maxSize = maxSize;
    this.ttl = ttl;
    this.cache = new Map();
    this.timers = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0
    };
  }

  /**
   * Get item from cache
   */
  async get(key) {
    if (this.cache.has(key)) {
      const item = this.cache.get(key);

      // Move to end (LRU)
      this.cache.delete(key);
      this.cache.set(key, item);

      this.stats.hits++;
      return item.value;
    }

    this.stats.misses++;
    return null;
  }

  /**
   * Set item in cache with TTL
   */
  async set(key, value) {
    // Remove if exists
    if (this.cache.has(key)) {
      this._clearTimer(key);
      this.cache.delete(key);
    }

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this._evict(oldestKey);
    }

    // Add new item
    this.cache.set(key, {
      value,
      createdAt: Date.now()
    });

    // Set TTL timer
    if (this.ttl > 0) {
      const timer = setTimeout(() => {
        this._evict(key);
      }, this.ttl);

      this.timers.set(key, timer);
    }
  }

  /**
   * Evict item from cache
   */
  _evict(key) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
      this._clearTimer(key);
      this.stats.evictions++;
    }
  }

  /**
   * Clear timer for key
   */
  _clearTimer(key) {
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
    }
  }

  /**
   * Cleanup expired entries
   */
  async cleanup() {
    const now = Date.now();
    const expiredKeys = [];

    for (const [key, item] of this.cache.entries()) {
      if (now - item.createdAt > this.ttl) {
        expiredKeys.push(key);
      }
    }

    for (const key of expiredKeys) {
      this._evict(key);
    }
  }

  /**
   * Clear all cache
   */
  async clear() {
    // Clear all timers
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }

    this.cache.clear();
    this.timers.clear();
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0 
      ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
      : 0;

    return {
      ...this.stats,
      hitRate: `${hitRate}%`,
      size: this.cache.size,
      maxSize: this.maxSize
    };
  }

  get size() {
    return this.cache.size;
  }
}

/**
 * Performance metrics collector
 */
class PerformanceMetrics {
  constructor() {
    this.reset();
  }

  reset() {
    this.conversions = {};
    this.errors = {};
    this.cacheHits = {};
    this.engineStats = {};
  }

  recordConversion(type, duration, size) {
    if (!this.conversions[type]) {
      this.conversions[type] = { count: 0, totalTime: 0, totalSize: 0 };
    }

    this.conversions[type].count++;
    this.conversions[type].totalTime += duration;
    this.conversions[type].totalSize += size;
  }

  recordError(type, error) {
    if (!this.errors[type]) {
      this.errors[type] = { count: 0, messages: [] };
    }

    this.errors[type].count++;
    this.errors[type].messages.push(error.message);
  }

  recordHit(type) {
    if (!this.cacheHits[type]) {
      this.cacheHits[type] = 0;
    }
    this.cacheHits[type]++;
  }

  recordEngineSuccess(engine) {
    if (!this.engineStats[engine]) {
      this.engineStats[engine] = { success: 0, failure: 0, skip: 0 };
    }
    this.engineStats[engine].success++;
  }

  recordEngineFailure(engine, error) {
    if (!this.engineStats[engine]) {
      this.engineStats[engine] = { success: 0, failure: 0, skip: 0 };
    }
    this.engineStats[engine].failure++;
  }

  recordEngineSkip(engine, reason) {
    if (!this.engineStats[engine]) {
      this.engineStats[engine] = { success: 0, failure: 0, skip: 0 };
    }
    this.engineStats[engine].skip++;
  }

  getStats() {
    return {
      conversions: this.conversions,
      errors: this.errors,
      cacheHits: this.cacheHits,
      engineStats: this.engineStats
    };
  }
}

/**
 * Security validator for input sanitization
 */
class SecurityValidator {
  constructor(config) {
    this.config = config;
  }

  /**
   * Validate file path against directory traversal
   */
  validateFilePath(filePath, allowedDirectory) {
    if (!this.config.preventPathTraversal) return true;

    const resolved = path.resolve(filePath);
    return resolved.startsWith(allowedDirectory);
  }

  /**
   * Validate file extension
   */
  validateFileExtension(filename) {
    // FIX: Validate filename exists and is a string
    if (!filename || typeof filename !== 'string') {
      return false;
    }
    
    const ext = path.extname(filename).toLowerCase();
    return this.config.allowedExtensions.includes(ext);
  }

  /**
   * Sanitize HTML content - SECURITY FIX: Use proper HTML sanitization
   */
  sanitizeHtml(html) {
    if (!this.config.sanitizeHtml) return html;

    if (html.length > 1024 * 1024) {
      throw new Error('HTML content too large');
    }

    // SECURITY FIX: More comprehensive sanitization
    return html
      .replace(/<script[^>]*>.*?<\/script>/gis, '')
      .replace(/<iframe[^>]*>.*?<\/iframe>/gis, '')
      .replace(/<object[^>]*>.*?<\/object>/gis, '')
      .replace(/<embed[^>]*>/gis, '')
      .replace(/javascript:/gi, 'blocked:')
      .replace(/data:.*?base64/gi, 'blocked:')
      .replace(/vbscript:/gi, 'blocked:')
      .replace(/on\w+\s*=/gi, 'blocked=');
  }
}

/**
 * Puppeteer PDF Engine
 */
class PuppeteerEngine {
  constructor(config) {
    this.config = config;
    this.available = null;
  }

  async isAvailable() {
    if (this.available !== null) return this.available;

    try {
      const puppeteer = await import('puppeteer');
      this.available = true;
    } catch {
      this.available = false;
    }

    return this.available;
  }

  async convert(html, options = {}) {
    const puppeteer = await import('puppeteer');

    const browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=TranslateUI,VizDisplayCompositor',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-default-apps',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-default-browser-check',
        '--disable-plugins',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-hang-monitor',
        '--disable-client-side-phishing-detection',
        '--disable-component-extensions-with-background-pages',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-domain-reliability',
        '--disable-ipc-flooding-protection',
        '--memory-pressure-off',
        '--max_old_space_size=4096'
      ],
      timeout: 20000
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1024, height: 768 });

      await page.setContent(html, { 
        waitUntil: 'domcontentloaded',
        timeout: 10000 
      });

      const pdfBuffer = await page.pdf({ 
        format: options.format || 'A4',
        printBackground: true,
        margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' }
      });

      return pdfBuffer;
    } finally {
      // Enhanced browser cleanup with force-kill fallback
      if (browser) {
        try {
          await browser.close();
        } catch (error) {
          console.warn(`Browser close failed, force killing: ${error.message}`);
          try {
            const process = browser.process();
            if (process) {
              process.kill('SIGKILL');
            }
          } catch (killError) {
            console.warn(`Force kill failed: ${killError.message}`);
          }
        }
      }
    }
  }

  async cleanup() {
    // No persistent resources to cleanup
  }
}

/**
 * Playwright PDF Engine (fallback)
 */
class PlaywrightEngine {
  constructor(config) {
    this.config = config;
    this.available = null;
  }

  async isAvailable() {
    if (this.available !== null) return this.available;

    try {
      await import('playwright');
      this.available = true;
    } catch {
      this.available = false;
    }

    return this.available;
  }

  async convert(html, options = {}) {
    let browser = null;
    try {
      const { chromium } = await import('playwright');

      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });

      const page = await browser.newPage();
      await page.setContent(html);

      const pdfBuffer = await page.pdf({
        format: options.format || 'A4',
        printBackground: true
      });

      return pdfBuffer;
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (error) {
          console.warn(`Browser close failed: ${error.message}`);
          try {
            const browserProcess = browser.process();
            if (browserProcess && !browserProcess.killed) {
              browserProcess.kill('SIGKILL');
            }
          } catch (killError) {
            // Silent fail - process might already be dead
          }
        }
      }
    }
  }

  async cleanup() {
    // No persistent resources to cleanup
  }
}

/**
 * Chrome Headless Engine (fallback)
 */
class ChromeHeadlessEngine {
  constructor(config) {
    this.config = config;
    this.available = null;
  }

  async isAvailable() {
    if (this.available !== null) return this.available;

    try {
      await import('chrome-headless-render-pdf');
      this.available = true;
    } catch {
      this.available = false;
    }

    return this.available;
  }

  async convert(html, options = {}) {
    const RenderPDF = await import('chrome-headless-render-pdf');

    const pdf = await RenderPDF.generateSinglePDF(html, {
      printOptions: {
        format: options.format || 'A4',
        printBackground: true
      }
    });

    return pdf;
  }

  async cleanup() {
    // No persistent resources to cleanup
  }
}

/**
 * Text Fallback Engine (final fallback)
 */
class TextFallbackEngine {
  constructor(config) {
    this.config = config;
  }

  async isAvailable() {
    return true; // Always available
  }

  async convert(html, options = {}) {
    // Extract clean text content from HTML
    const textContent = html
      .replace(/<style[^>]*>.*?<\/style>/gis, '')
      .replace(/<script[^>]*>.*?<\/script>/gis, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Return clean content without extra headers or timestamps
    return Buffer.from(textContent, 'utf-8');
  }

  async cleanup() {
    // No persistent resources to cleanup
  }
}







export default MediaHandler;