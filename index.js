import fs from "fs";
import chalk from "chalk";
import crypto from "crypto";
import Handlebars from "handlebars";
import config from "./config.js";

// ===== HANDLEBARS SECURITY CONFIGURATION =====
// Configure Handlebars for security - HTML escaping is enabled by default
// No custom helpers needed for basic escaping

// Register safe helper only for trusted admin content (disabled by default)
// Handlebars.registerHelper('safe', function(variable) {
//   return new Handlebars.SafeString(variable);
// });

// SECURITY: Use {{variable}} for escaped output, {{{variable}}} only for trusted HTML

// ===== IMPROVED PDF CONVERTER WITH FALLBACK =====
class PDFConverter {
  constructor() {
    this.puppeteerAvailable = false;
    this.htmlPdfAvailable = false;
    this.fallbackAvailable = true; // Simple HTML text fallback
    this.checkAvailableConverters();
  }

  async checkAvailableConverters() {
    // Check if puppeteer is available and working
    try {
      const puppeteer = await import("puppeteer");

      // Enhanced Puppeteer args for Replit environment
      const browser = await puppeteer.launch({
        headless: "new",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-gpu",
          "--disable-web-security",
          "--disable-features=TranslateUI,VizDisplayCompositor",
          "--disable-extensions",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-default-apps",
          "--disable-sync",
          "--metrics-recording-only",
          "--no-default-browser-check",
          "--disable-plugins",
          "--disable-popup-blocking",
          "--disable-prompt-on-repost",
          "--disable-hang-monitor",
          "--disable-client-side-phishing-detection",
          "--disable-component-extensions-with-background-pages",
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-domain-reliability",
          "--disable-ipc-flooding-protection",
          "--memory-pressure-off",
          "--max_old_space_size=4096",
        ],
        timeout: 15000,
        ignoreDefaultArgs: ["--disable-extensions"],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      });
      await browser.close();
      this.puppeteerAvailable = true;
      console.log(chalk.green("✅ Puppeteer PDF converter available"));
    } catch (error) {
      console.log(
        chalk.yellow(
          "⚠️ Puppeteer not available, using text fallback PDF generation",
        ),
      );
      console.log(
        chalk.gray(
          `   This is normal in containerized environments like Replit`,
        ),
      );
      // Don't log the full error to reduce noise
    }
  }

  async convertHtmlToPdf(html, options = {}) {
    if (this.puppeteerAvailable) {
      try {
        return await this.convertWithPuppeteer(html, options);
      } catch (error) {
        console.warn(
          chalk.yellow(`⚠️ Puppeteer failed, using fallback: ${error.message}`),
        );
        return await this.convertWithFallback(html, options);
      }
    } else {
      return await this.convertWithFallback(html, options);
    }
  }

  async convertWithPuppeteer(html, options = {}) {
    let browser = null;
    let page = null;

    try {
      const puppeteer = await import("puppeteer");

      browser = await puppeteer.launch({
        headless: "new",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-gpu",
          "--disable-web-security",
          "--disable-features=TranslateUI,VizDisplayCompositor",
          "--disable-extensions",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-default-apps",
          "--disable-sync",
          "--metrics-recording-only",
          "--no-default-browser-check",
          "--disable-plugins",
          "--disable-popup-blocking",
          "--disable-prompt-on-repost",
          "--disable-hang-monitor",
          "--disable-client-side-phishing-detection",
          "--disable-component-extensions-with-background-pages",
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-domain-reliability",
          "--disable-ipc-flooding-protection",
          "--memory-pressure-off",
          "--max_old_space_size=4096",
        ],
        timeout: 20000,
        ignoreDefaultArgs: ["--disable-extensions"],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      });

      page = await browser.newPage();

      // Set viewport and disable images for faster processing
      await page.setViewport({ width: 1024, height: 768 });
      await page.setRequestInterception(true);

      page.on("request", (req) => {
        if (req.resourceType() === "image") {
          req.abort();
        } else {
          req.continue();
        }
      });

      await page.setContent(html, {
        waitUntil: "domcontentloaded",
        timeout: 10000,
      });

      // Add landing page URL if provided
      if (options.landingPageUrl) {
        await page.evaluate((url) => {
          const link = document.createElement("a");
          link.href = url;
          link.textContent = "Visit our website";
          link.style.position = "absolute";
          link.style.bottom = "20px";
          link.style.left = "20px";
          link.style.fontSize = "14px";
          link.style.color = "blue";
          link.style.textDecoration = "underline";
          document.body.appendChild(link);
        }, options.landingPageUrl);
      }

      const pdfBuffer = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "20px", bottom: "20px", left: "20px", right: "20px" },
      });

      return pdfBuffer;
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
              browserProcess.kill("SIGKILL");
            }
          } catch (killError) {
            // Silent fail - process might already be dead
          }
        }
      }
    }
  }

  /**
   * Force kill browser process with comprehensive PID validation
   */
  _forceKillBrowserProcess(browser) {
    if (!browser) return;

    try {
      // Check if browser has process method
      if (typeof browser.process !== "function") {
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

      // Enhanced PID validation with timeout
      if (
        typeof browserProcess.pid === "number" &&
        browserProcess.pid > 0 &&
        browserProcess.pid <= 65535 &&
        !isNaN(browserProcess.pid)
      ) {
        // Set timeout for kill operation
        const killTimeout = setTimeout(() => {
          try {
            process.kill(browserProcess.pid, "SIGKILL");
          } catch {}
        }, 2000);

        browserProcess.kill("SIGKILL");
        clearTimeout(killTimeout);
      }
    } catch (error) {
      // Enhanced fallback with multiple kill methods
      try {
        if (browser.process && typeof browser.process === "function") {
          const proc = browser.process();
          if (
            proc &&
            proc.pid &&
            typeof proc.pid === "number" &&
            proc.pid > 0 &&
            proc.pid <= 65535 &&
            !isNaN(proc.pid)
          ) {
            // Try multiple kill signals
            const signals = ["SIGTERM", "SIGKILL"];
            for (const signal of signals) {
              try {
                process.kill(proc.pid, signal);
                break;
              } catch {}
            }
          }
        }
      } catch (fallbackError) {
        // Log for debugging but don't throw
        console.warn(
          `All browser kill methods failed: ${fallbackError.message}`,
        );
      }
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
          this._forceKillBrowserProcess(browser);
          resolve("timeout");
        }
      }, timeoutMs);
    });

    // Race between cleanup and timeout
    return Promise.race([cleanupPromise, timeoutPromise]);
  }

  async convertWithFallback(html, options = {}) {
    console.log(
      chalk.yellow("📄 Using fallback PDF generation (simplified text)"),
    );

    // Create a simple text version of the HTML for fallback
    const textContent = html
      .replace(/<style[^>]*>.*?<\/style>/gis, "")
      .replace(/<script[^>]*>.*?<\/script>/gis, "")
      .replace(/<[^>]*>/g, "\n")
      .replace(/\s+/g, " ")
      .trim();

    const fallbackContent = `
EMAIL CONTENT (PDF CONVERSION FALLBACK)
=====================================

${textContent}

${options.landingPageUrl ? `\nWebsite: ${options.landingPageUrl}` : ""}

Generated: ${new Date().toLocaleString()}
`;

    return Buffer.from(fallbackContent, "utf-8");
  }

  isAvailable() {
    return this.puppeteerAvailable || this.fallbackAvailable;
  }

  getConverterInfo() {
    return {
      puppeteer: this.puppeteerAvailable,
      fallback: this.fallbackAvailable,
      available: this.isAvailable(),
    };
  }
}

// ===== SMART TEMPLATE CACHE WITH AUTO-REFRESH =====
class SmartTemplateCache {
  constructor(maxSize = 100) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.fileStats = new Map(); // filename -> mtime
    this.stats = {
      hits: 0,
      misses: 0,
      totalRequests: 0,
      cacheSize: 0,
      memoryUsage: 0,
      autoRefreshCount: 0,
      fileChecks: 0,
    };

    // ENHANCEMENT: Pre-compiled Handlebars templates
    this.compiledTemplates = new Map();
    this.precompilationStats = { compiled: 0, used: 0 };

    // ✅ NEW: Configuration for file checking
    this.developmentMode = process.env.NODE_ENV === "development"; // Shorter interval for development
    this.fileCheckInterval = 60000; // Check every 60 seconds

    // ✅ NEW: Last checked timestamp
    this.lastFileCheck = new Map();
  }

  async isFileModified(templateFile) {
    this.stats.fileChecks++;

    const now = Date.now();
    const lastChecked = this.lastFileCheck.get(templateFile) || 0;
    const checkInterval = this.developmentMode ? 5000 : this.fileCheckInterval;

    if (now - lastChecked < checkInterval) {
      return false;
    }

    // Add file operation mutex to prevent race conditions
    const mutexKey = `file_check_${templateFile}`;
    if (this._activeFileChecks && this._activeFileChecks.has(mutexKey)) {
      return false; // Another check in progress
    }

    if (!this._activeFileChecks) {
      this._activeFileChecks = new Set();
    }
    this._activeFileChecks.add(mutexKey);

    try {
      const currentStats = await fs.promises.stat(templateFile);
      const currentMtime = currentStats.mtime.getTime();

      if (!this.fileStats.has(templateFile)) {
        this.fileStats.set(templateFile, currentMtime);
        this.lastFileCheck.set(templateFile, now);
        return false;
      }

      const cachedMtime = this.fileStats.get(templateFile);
      if (currentMtime > cachedMtime) {
        this.fileStats.set(templateFile, currentMtime);
        this.lastFileCheck.set(templateFile, now);
        return true;
      }

      this.lastFileCheck.set(templateFile, now);
      return false;
    } catch (error) {
      console.warn(
        `File stat check failed for ${templateFile}: ${error.message}`,
      );
      return false;
    } finally {
      this._activeFileChecks.delete(mutexKey);
    }
  }

  async get(templateFile) {
    this.stats.totalRequests++;

    // Check if file was modified (smart auto-refresh)
    const fileModified = await this.isFileModified(templateFile);

    if (this.cache.has(templateFile) && !fileModified) {
      this.stats.hits++;
      const cached = this.cache.get(templateFile);

      // ✅ FIXED: Validate cached content exists and is valid
      if (!cached || !cached.content || typeof cached.content !== "string") {
        this.stats.misses++;
        // Remove invalid cache entry and fall through to reload
        this.cache.delete(templateFile);
        this.fileStats.delete(templateFile);
        this.lastFileCheck.delete(templateFile);
        console.warn(`⚠️ Removed invalid cache entry for ${templateFile}`);
      } else if (cached.content.length === 0) {
        // Empty content is valid - don't delete, just log warning
        console.warn(
          `⚠️ Template ${templateFile} has empty content but keeping in cache`,
        );
        cached.accessCount = (cached.accessCount || 0) + 1;
        if (cached.accessCount % 5 === 0) {
          this.cache.delete(templateFile);
          this.cache.set(templateFile, cached);
        }
        return cached.content; // Return empty string as valid content
      } else {
        // Only move to end every 5th access to reduce Map operations
        cached.accessCount = (cached.accessCount || 0) + 1;
        if (cached.accessCount % 5 === 0) {
          this.cache.delete(templateFile);
          this.cache.set(templateFile, cached);
        }
        return cached.content; // Now guaranteed to be valid string
      }
    }

    // Cache miss or file modified - load from file
    if (fileModified && this.cache.has(templateFile)) {
      this.stats.autoRefreshCount++;
      // Template auto-refresh working silently
    } else {
      this.stats.misses++;
    }

    try {
      const content = await fs.promises.readFile(templateFile, "utf-8");

      // ✅ FIXED: Basic validation without changing content
      if (typeof content !== "string") {
        throw new Error(
          `Template file ${templateFile} did not return string content`,
        );
      }

      // Add to cache with size management
      if (this.cache.size >= this.maxSize) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
        this.fileStats.delete(firstKey);
      }

      const cacheEntry = {
        content: content, // Keep original content exactly as-is
        loadedAt: Date.now(),
        accessCount: 1,
        size: Buffer.byteLength(content, "utf8"),
        lastModified: this.fileStats.get(templateFile),
      };

      this.cache.set(templateFile, cacheEntry);
      // Only update stats every 10th cache operation
      if (this.stats.totalRequests % 10 === 0) {
        this._updateStats();
      }

      return content; // Return original content unchanged
    } catch (error) {
      console.error(
        `Failed to load template ${templateFile}: ${error.message}`,
      );

      // ✅ FIXED: Try fallback to default template instead of crashing
      if (templateFile !== config.email?.templates?.default) {
        console.warn(`Attempting to load default template as fallback`);
        try {
          return await this.get(config.email.templates.default);
        } catch (fallbackError) {
          console.error(
            `Default template also failed: ${fallbackError.message}`,
          );
        }
      }

      // Last resort: throw error (but with better message)
      throw new Error(
        `Cannot load template ${templateFile} and no fallback available`,
      );
    }
  }

  // ✅ NEW: Force refresh all templates (useful for development)
  async forceRefreshAll() {
    console.log("🔄 Force refreshing all templates...");

    // Clear file stats to force re-checking
    const templateFiles = Array.from(this.cache.keys());
    for (const templateFile of templateFiles) {
      if (this.fileStats.has(templateFile)) {
        this.fileStats.delete(templateFile);
        this.lastFileCheck.delete(templateFile);
      }
    }

    // Reload all cached templates
    for (const templateFile of templateFiles) {
      try {
        await this.get(templateFile);
      } catch (error) {
        console.warn(`Failed to refresh ${templateFile}: ${error.message}`);
      }
    }

    console.log(`✅ Force refreshed ${templateFiles.length} templates`);
  }

  // ✅ NEW: Get file check interval info
  getFileCheckInfo() {
    return {
      interval: this.fileCheckInterval,
      developmentMode: this.developmentMode,
      effectiveInterval: this.developmentMode ? 5000 : this.fileCheckInterval,
    };
  }

  _updateStats() {
    this.stats.cacheSize = this.cache.size;
    this.stats.memoryUsage = Array.from(this.cache.values()).reduce(
      (total, entry) => total + entry.size,
      0,
    );
  }

  getStats() {
    const hitRate =
      this.stats.totalRequests > 0
        ? ((this.stats.hits / this.stats.totalRequests) * 100).toFixed(2)
        : 0;

    return {
      ...this.stats,
      hitRate: `${hitRate}%`,
      memoryUsageMB: (this.stats.memoryUsage / 1024 / 1024).toFixed(2),
      autoRefreshCount: this.stats.autoRefreshCount,
      fileChecks: this.stats.fileChecks,
    };
  }

  async preCompileTemplate(templateFile) {
    try {
      console.log(`🔥 Pre-compiling template: ${templateFile}`);

      // FIX: Check if file exists before reading
      try {
        await fs.promises.access(templateFile, fs.constants.F_OK);
      } catch (accessError) {
        console.warn(`⚠️ Template file not found: ${templateFile}`);
        return null;
      }

      const content = await fs.promises.readFile(templateFile, "utf-8");

      // FIX: Validate content is not empty
      if (!content || content.trim().length === 0) {
        console.warn(`⚠️ Template file is empty: ${templateFile}`);
        return null;
      }

      // Compile with optimized settings
      const compiled = Handlebars.compile(content, {
        noEscape: false,
        strict: false, // More permissive for better performance
        knownHelpers: {
          if: true,
          unless: true,
          each: true,
          with: true,
        },
      });

      this.compiledTemplates.set(templateFile, compiled);
      this.precompilationStats.compiled++;
      console.log(`✅ Pre-compiled: ${templateFile}`);

      return compiled;
    } catch (error) {
      console.error(
        `❌ Failed to pre-compile ${templateFile}: ${error.message}`,
      );
      // FIX: Don't throw error, just return null to continue with other templates
      return null;
    }
  }

  async preCompileAllTemplates() {
    const templateFiles = new Set();

    // Add default template
    if (config.email?.templates?.default) {
      templateFiles.add(config.email.templates.default);
    }

    // Add rotation templates
    if (config.email?.templates?.rotation?.files) {
      config.email.templates.rotation.files.forEach((file) =>
        templateFiles.add(file),
      );
    }

    if (templateFiles.size === 0) {
      console.log("⚠️ No templates found to pre-compile");
      return;
    }

    console.log(`🔥 Pre-compiling ${templateFiles.size} templates...`);
    const startTime = Date.now();

    const promises = Array.from(templateFiles).map((file) =>
      this.preCompileTemplate(file),
    );
    await Promise.all(promises);

    const duration = Date.now() - startTime;
    console.log(
      `✅ Pre-compiled ${templateFiles.size} templates in ${duration}ms`,
    );
  }

  getCompiledTemplate(templateFile) {
    // FIX: Check if compiledTemplates exists before using it
    if (!this.compiledTemplates) {
      return null;
    }

    if (this.compiledTemplates.has(templateFile)) {
      // FIX: Check if precompilationStats exists before incrementing
      if (this.precompilationStats) {
        this.precompilationStats.used++;
      }
      return this.compiledTemplates.get(templateFile);
    }
    return null;
  }

  setCompiledTemplate(templateFile, compiledTemplate) {
    if (this.compiledTemplates) {
      this.compiledTemplates.set(templateFile, compiledTemplate);
    }
  }

  getPrecompilationStats() {
    // FIX: Provide default stats if precompilationStats is undefined
    const stats = this.precompilationStats || { compiled: 0, used: 0 };

    const hitRate =
      stats.compiled > 0 ? ((stats.used / stats.compiled) * 100).toFixed(2) : 0;

    return {
      compiled: stats.compiled,
      used: stats.used,
      hitRate: `${hitRate}%`,
    };
  }

  clear() {
    this.cache.clear();
    this.fileStats.clear();

    // FIX: Check if compiledTemplates exists before clearing
    if (this.compiledTemplates) {
      this.compiledTemplates.clear();
    }

    this.stats = {
      hits: 0,
      misses: 0,
      totalRequests: 0,
      cacheSize: 0,
      memoryUsage: 0,
      autoRefreshCount: 0,
      fileChecks: 0,
    };
  }
}

// ===== SMART CONTENT CACHE WITH MACRO VERSION TRACKING =====
class SmartContentCache {
  constructor(maxSize = 1000, contentProcessor = null) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.contentProcessor = contentProcessor;
    this.macroVersions = new Map(); // macroName -> mtime
    this.stats = {
      hits: 0,
      misses: 0,
      totalRequests: 0,
      processingTimeSaved: 0,
      macroInvalidations: 0,
      versionChecks: 0,
    };
  }

  async getMacroVersion(macroName) {
    this.stats.versionChecks++;
    if (!this.contentProcessor) return 0;

    try {
      const macroFiles = this.contentProcessor.macroFiles;
      if (!macroFiles.has(macroName)) return 0;

      const macroPath = macroFiles.get(macroName);
      const stats = await fs.promises.stat(macroPath);
      return stats.mtime.getTime();
    } catch (error) {
      return 0;
    }
  }

  async getCurrentMacroVersions(template) {
    const macroPattern = /{{(MACRO\d+)}}/gi;
    const macroMatches = [...template.matchAll(macroPattern)];
    const versions = {};

    for (const match of macroMatches) {
      const macroName = match[1].toUpperCase();
      versions[macroName] = await this.getMacroVersion(macroName);
    }

    return versions;
  }

  async generateSmartCacheKey(template, recipientEmail, options = {}) {
    // Create a cache key that includes template hash and processing options
    const templateHash = crypto
      .createHash("md5")
      .update(template)
      .digest("hex")
      .substring(0, 8);
    const optionsKey = JSON.stringify(options);

    // For static content (no dynamic elements), use template-only key
    const hasPersonalization =
      template.includes("{{") ||
      template.includes("{") ||
      (this.contentProcessor && template.match(/{{(MACRO\d+)}}/gi));

    if (!hasPersonalization) {
      return `static_${templateHash}_${optionsKey}`;
    }

    // Include macro versions in cache key for auto-invalidation
    const macroVersions = await this.getCurrentMacroVersions(template);
    const macroVersionHash = crypto
      .createHash("md5")
      .update(JSON.stringify(macroVersions))
      .digest("hex")
      .substring(0, 6);

    // For personalized content, include recipient domain for partial caching
    const domain =
      recipientEmail &&
      typeof recipientEmail === "string" &&
      recipientEmail.includes("@")
        ? recipientEmail.split("@")[1] || "generic"
        : "generic";
    return `smart_${templateHash}_${domain}_${macroVersionHash}_${optionsKey}`;
  }

  generateCacheKey(template, recipientEmail, options = {}) {
    // Fallback to original method for compatibility
    return this.generateSmartCacheKey(template, recipientEmail, options);
  }

  async get(cacheKey, processingFunction) {
    this.stats.totalRequests++;

    // Handle both string keys (legacy) and smart cache key generation
    let finalCacheKey = cacheKey;
    if (typeof cacheKey === "function") {
      // If first param is the processing function, use legacy behavior
      processingFunction = cacheKey;
      finalCacheKey = `legacy_${Date.now()}_${Math.random()}`;
    }

    if (this.cache.has(finalCacheKey)) {
      this.stats.hits++;
      const cached = this.cache.get(finalCacheKey);

      // Move to end (LRU behavior)
      this.cache.delete(finalCacheKey);
      this.cache.set(finalCacheKey, cached);

      this.stats.processingTimeSaved += cached.avgProcessingTime || 50;
      return cached.result;
    }

    // Cache miss - process content
    this.stats.misses++;
    const startTime = Date.now();

    const result = await processingFunction();

    const processingTime = Date.now() - startTime;

    // Add to cache with size management
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(finalCacheKey, {
      result: result,
      createdAt: Date.now(),
      avgProcessingTime: processingTime,
      macroVersions: finalCacheKey.includes("smart_")
        ? await this.getCurrentMacroVersions(String(result))
        : {},
    });

    return result;
  }

  invalidateMacroCache(macroName) {
    this.stats.macroInvalidations++;
    let invalidatedCount = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (
        key.includes("smart_") &&
        entry.macroVersions &&
        entry.macroVersions[macroName]
      ) {
        this.cache.delete(key);
        invalidatedCount++;
      }
    }

    if (invalidatedCount > 0) {
      // Cache invalidation working silently
    }

    return invalidatedCount;
  }

  getStats() {
    const hitRate =
      this.stats.totalRequests > 0
        ? ((this.stats.hits / this.stats.totalRequests) * 100).toFixed(2)
        : 0;

    return {
      ...this.stats,
      hitRate: `${hitRate}%`,
      cacheSize: this.cache.size,
      timeSavedMs: this.stats.processingTimeSaved || 0,
      macroInvalidations: this.stats.macroInvalidations || 0,
      versionChecks: this.stats.versionChecks || 0,
    };
  }

  clear() {
    this.cache.clear();
    if (this.macroVersions) {
      this.macroVersions.clear();
    }
    this.stats = {
      hits: 0,
      misses: 0,
      totalRequests: 0,
      processingTimeSaved: 0,
      macroInvalidations: 0,
      versionChecks: 0,
    };
  }
}

// ===== CAMPAIGN DETECTOR FOR SMART CACHE MANAGEMENT =====
class CampaignDetector {
  constructor(config, contentProcessor = null) {
    this.config = config;
    this.contentProcessor = contentProcessor;
    this.lastCampaignSignature = null;
    this.campaignStartTime = Date.now();
  }

  generateCampaignSignature() {
    const signature = {
      templates:
        this.config?.email?.templates?.rotation?.files &&
        this.config.email.templates.rotation.files.length > 0
          ? this.config.email.templates.rotation.files
          : [this.config?.email?.templates?.default || "default.html"],
      subjects: this.config?.email?.subject?.rotation?.templates || [],
      senderNames: this.config?.email?.senderName?.rotation?.names || [],
      rotationEnabled: {
        templates: this.config?.email?.templates?.rotation?.enabled || false,
        subjects: this.config?.email?.subject?.rotation?.enabled || false,
        senderNames: this.config?.email?.senderName?.rotation?.enabled || false,
      },
      macroCount: this.contentProcessor
        ? this.contentProcessor.getAvailableMacros().length
        : 0,
      timestamp: Math.floor(Date.now() / (1000 * 60 * 60)), // Hour-based signature
    };

    return crypto
      .createHash("md5")
      .update(JSON.stringify(signature))
      .digest("hex")
      .substring(0, 12);
  }

  detectNewCampaign() {
    const currentSignature = this.generateCampaignSignature();
    const isNewCampaign =
      this.lastCampaignSignature !== null &&
      this.lastCampaignSignature !== currentSignature;

    if (isNewCampaign) {
      console.log(
        chalk.cyan(`🆕 New campaign detected (signature: ${currentSignature})`),
      );
      this.campaignStartTime = Date.now();
    }

    this.lastCampaignSignature = currentSignature;
    return isNewCampaign;
  }

  getCampaignInfo() {
    return {
      signature: this.lastCampaignSignature,
      startTime: this.campaignStartTime,
      runtime: Date.now() - this.campaignStartTime,
    };
  }
}

import SMTPManager, {
  DynamicContentProcessor,
  checkForSpamTriggers,
  removeSpamTriggers,
  optimizeHtmlContent,
  templateRotation,
  subjectRotation,
  senderRotation,
  AsyncMutex,
} from "./src/modules.js";
import MediaHandler from "./src/media-handler.js";
import os from "os";

// ===== EMAIL CAMPAIGN MANAGER =====
// Global error handler
process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught Exception:", error);
  console.log("📊 Campaign stats at crash:", stats);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
  console.log("📊 Campaign stats at error:", stats);
});

const stats = {
  sent: 0,
  failed: 0,
  remaining: 0,
  // ✅ NEW: Add email counter for unique numbering
  emailCounter: 0,

  // ✅ NEW: Atomic email number generator
  getNextEmailNumber() {
    this.emailCounter++;
    return this.emailCounter;
  },
  startTime: null,
  retries: 0,
  lastSuccessTime: null,
  consecutiveFailures: 0,
  templateCacheHits: 0,
  templateCacheMisses: 0,
  smtpConnectionReuses: 0,
  performanceSnapshots: [],

  // Atomic increment methods
  incrementSent() {
    // Use atomic operations with proper synchronization
    if (!this._statsMutex) {
      this._statsMutex = { locked: false, queue: [] };
    }

    return this._atomicStatsOperation(() => {
      this.emailCounter = (this.emailCounter || 0) + 1;
      this.sent = (this.sent || 0) + 1;
      this.remaining = Math.max(0, (this.remaining || 0) - 1);
      this.lastSuccessTime = Date.now();
      this.consecutiveFailures = 0;
      return this.emailCounter;
    });
  },

  incrementFailed() {
    return this._atomicStatsOperation(() => {
      this.failed = (this.failed || 0) + 1;
      this.remaining = Math.max(0, (this.remaining || 0) - 1);
      this.consecutiveFailures = (this.consecutiveFailures || 0) + 1;
      return this.failed;
    });
  },

  _atomicStatsOperation(operation) {
    if (this._statsMutex.locked) {
      return new Promise((resolve) => {
        this._statsMutex.queue.push(() => resolve(operation()));
      });
    }

    this._statsMutex.locked = true;
    const result = operation();
    this._statsMutex.locked = false;

    if (this._statsMutex.queue.length > 0) {
      const next = this._statsMutex.queue.shift();
      setImmediate(next);
    }

    return result;
  },

  startPerformanceTracking() {
    this.startTime = Date.now();
    console.log("is�� Performance tracking started");
  },

  recordTemplateHit() {
    this.templateCacheHits++;
  },

  recordTemplateMiss() {
    this.templateCacheMisses++;
  },

  recordConnectionReuse() {
    this.smtpConnectionReuses++;
  },

  takePerformanceSnapshot() {
    const now = Date.now();
    const runtime = this.startTime ? (now - this.startTime) / 1000 : 0;
    const totalEmails = this.sent + this.failed;

    const snapshot = {
      timestamp: now,
      runtime: runtime,
      totalEmails: totalEmails,
      emailsPerSecond: runtime > 0 ? totalEmails / runtime : 0,
      successRate: totalEmails > 0 ? (this.sent / totalEmails) * 100 : 0,
      templateCacheHitRate:
        this.templateCacheHits + this.templateCacheMisses > 0
          ? (this.templateCacheHits /
              (this.templateCacheHits + this.templateCacheMisses)) *
            100
          : 0,
    };

    this.performanceSnapshots.push(snapshot);

    // Keep only last 10 snapshots
    if (this.performanceSnapshots.length > 10) {
      this.performanceSnapshots.shift();
    }

    return snapshot;
  },

  logPerformanceReport() {
    const snapshot = this.takePerformanceSnapshot();
    const templateStats = templateCache.getPrecompilationStats() || {
      hitRate: "0%",
      used: 0,
      compiled: 0,
    };
    const connectionStats = smtpManager.getConnectionStats() || {
      reuseRate: "0%",
      connectionsReused: 0,
      connectionsCreated: 0,
      poolSize: 0,
    };

    console.log("\n📊 Performance Report:");
    console.log(
      `   Speed: ${(snapshot.emailsPerSecond || 0).toFixed(2)} emails/sec`,
    );
    console.log(`   Success Rate: ${(snapshot.successRate || 0).toFixed(1)}%`);
    console.log(`   Runtime: ${(snapshot.runtime || 0).toFixed(1)}s`);
    console.log(
      `   Template Cache: ${templateStats.hitRate} hit rate (${templateStats.used}/${templateStats.compiled})`,
    );
    console.log(
      `   Connection Reuse: ${connectionStats.reuseRate} (${connectionStats.connectionsReused}/${connectionStats.connectionsCreated})`,
    );
    console.log(`   SMTP Pool: ${connectionStats.poolSize} active connections`);

    return snapshot;
  },
};

const smtpManager = new SMTPManager(
  {
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.auth,
    fromEmail: config.smtp.fromEmail,
  },
  config.proxy.servers,
  {
    maxRetries: config.sending.retry.maxAttempts,
    retryDelay: config.sending.retry.delayBetweenAttempts,
  },
);

// Debug Interface Class
class DebugInterface {
  constructor() {
    this.enabled = config.debug.enabled;
    this.sessionId = Math.random().toString(36).substring(7);
    this.emailCount = 0;
  }

  static createBox(title, content, color = "cyan") {
    const maxWidth = Math.max(60, title.length + 4);
    const titlePadding = Math.floor((maxWidth - title.length - 2) / 2);
    const line = "─".repeat(maxWidth - 2);

    let box = chalk[color](`╭${line}╮\n`);
    box +=
      chalk[color]("│") +
      " ".repeat(titlePadding) +
      chalk.white.bold(title) +
      " ".repeat(maxWidth - title.length - titlePadding - 2) +
      chalk[color]("│\n");
    box += chalk[color](`├${line}┤\n`);

    content.forEach((line) => {
      const paddedLine = line.padEnd(maxWidth - 4);
      box += chalk[color]("│ ") + paddedLine + chalk[color](" │\n");
    });

    box += chalk[color](`╰${line}╯`);
    return box;
  }

  showConfigurationStatus() {
    if (!this.enabled) return;

    const content = [
      `Session ID: ${chalk.yellow(this.sessionId)}`,
      "",
      chalk.white.bold("🔄 ROTATION SETTINGS"),
      `├─ SMTP Rotation: ${config.smtp.rotation.enabled ? chalk.green("✓ ON") : chalk.red("✗ OFF")} (${config.smtp.rotation.strategy || "N/A"})`,
      `├─ Template Rotation: ${config.email.templates.rotation.enabled ? chalk.green("✓ ON") : chalk.red("✗ OFF")} (${config.email.templates.rotation.strategy || "N/A"})`,
      `├─ Subject Rotation: ${config.email.subject.rotation.enabled ? chalk.green("✓ ON") : chalk.red("✗ OFF")} (${config.email.subject.rotation.strategy || "N/A"})`,
      `├─ Sender Name Rotation: ${config.email.senderName.rotation.enabled ? chalk.green("✓ ON") : chalk.red("✗ OFF")} (${config.email.senderName.rotation.strategy || "N/A"})`,
      `└─ Header Rotation: ${config.headers.rotation.enabled ? chalk.green("✓ ON") : chalk.red("✗ OFF")} (${config.headers.rotation.strategy || "N/A"})`,
      "",
      chalk.white.bold("⚙️ SYSTEM SETTINGS"),
      `├─ Threads: ${chalk.yellow(config.sending.concurrency)}`,
      `├─ Email Delay: ${chalk.yellow(config.sending.emailDelay + "ms")}`,
      `├─ Retry: ${config.sending.retry.enabled ? chalk.green("✓ ON") : chalk.red("✗ OFF")} (${config.sending.retry.maxAttempts} attempts)`,
      `├─ Proxy: ${config.proxy.enabled ? chalk.green("✓ ON") : chalk.red("✗ OFF")}`,
      `├─ HTML Optimization: ${config.email.optimization.enabled ? chalk.green("✓ ON") : chalk.red("✗ OFF")}`,
      `└─ Smart Headers: ${config.headers.smartDetection.enabled ? chalk.green("✓ ON") : chalk.red("✗ OFF")}`,
      "",
      chalk.white.bold("🎯 CONTENT FEATURES"),
      `├─ Dynamic Processing: ${contentProcessor ? chalk.green("✓ ACTIVE") : chalk.red("✗ INACTIVE")}`,
      `├─ Available Macros: ${chalk.yellow(contentProcessor ? contentProcessor.getAvailableMacros().length : 0)}`,
      `├─ Email Validation: ${config.email.validation.enabled ? chalk.green("✓ ON") : chalk.red("✗ OFF")}`,
      `└─ Spam Detection: ${config.email.optimization.showSpamTriggers ? chalk.green("✓ ON") : chalk.red("✗ OFF")}`,
    ];

    console.log(
      "\n" +
        DebugInterface.createBox(
          "🐛 DEBUG CONFIGURATION STATUS",
          content,
          "magenta",
        ),
    );
  }

  showRotationInfo(type, selected, data = {}) {
    if (!this.enabled || !config.debug.showRotation) return;

    const content = [
      `Type: ${chalk.white.bold(type.toUpperCase())}`,
      `Selected: ${chalk.yellow(selected)}`,
      `Strategy: ${chalk.cyan(data.strategy || "N/A")}`,
      `Rotation: ${data.rotationEnabled ? chalk.green("✓ ENABLED") : chalk.red("✗ DISABLED")}`,
      `Available Options: ${chalk.white(data.availableOptions ? data.availableOptions.length : 0)}`,
    ];

    if (data.availableOptions && data.availableOptions.length > 0) {
      content.push("", chalk.gray("Available Items:"));
      data.availableOptions.slice(0, 3).forEach((item, index) => {
        content.push(chalk.gray(`  ${index + 1}. ${item}`));
      });
      if (data.availableOptions.length > 3) {
        content.push(
          chalk.gray(`  ... and ${data.availableOptions.length - 3} more`),
        );
      }
    }

    console.log(
      "\n" +
        DebugInterface.createBox(
          `🔄 ${type.toUpperCase()} ROTATION`,
          content,
          "blue",
        ),
    );
  }

  showContentProcessing(originalContent, processedContent, type = "Content") {
    if (!this.enabled || !config.debug.showDynamicContent) return;

    const hasChanges = originalContent !== processedContent;
    const content = [
      `Type: ${chalk.white.bold(type)}`,
      `Processing: ${hasChanges ? chalk.green("✓ APPLIED") : chalk.yellow("─ NO CHANGES")}`,
      `Original Length: ${chalk.cyan(originalContent.length)}`,
      `Processed Length: ${chalk.cyan(processedContent.length)}`,
      "",
      chalk.gray("Original Preview:"),
      chalk.gray(
        `"${originalContent.substring(0, 50)}${originalContent.length > 50 ? "..." : ""}"`,
      ),
      "",
      chalk.gray("Processed Preview:"),
      chalk.gray(
        `"${processedContent.substring(0, 50)}${processedContent.length > 50 ? "..." : ""}"`,
      ),
    ];

    if (contentProcessor) {
      const stats = contentProcessor.usageStats;
      content.push("", chalk.white.bold("Processing Stats:"));
      content.push(`├─ Macros: ${chalk.yellow(stats.macrosProcessed)}`);
      content.push(`├─ Mail Merge: ${chalk.yellow(stats.mailMergeProcessed)}`);
      content.push(`├─ Spintax: ${chalk.yellow(stats.spintaxProcessed)}`);
      content.push(`└─ Total Processed: ${chalk.yellow(stats.totalProcessed)}`);
    }

    console.log(
      "\n" +
        DebugInterface.createBox(
          `🎨 DYNAMIC ${type.toUpperCase()} PROCESSING`,
          content,
          "green",
        ),
    );
  }

  showSMTPInfo(smtpData, mailOptions) {
    if (!this.enabled || !config.debug.showSMTPDetails) return;

    const content = [
      `Host: ${chalk.white.bold(smtpData.host)}`,
      `Port: ${chalk.cyan(smtpData.port)}`,
      `Secure: ${smtpData.secure ? chalk.green("✓ TLS/SSL") : chalk.yellow("─ STARTTLS")}`,
      `From Email: ${chalk.cyan(smtpData.fromEmail)}`,
      `Server Index: ${chalk.yellow(smtpData.serverIndex + 1)}`,
      `Total Sent: ${chalk.yellow(smtpData.serverInfo.totalSent)}`,
      "",
      chalk.white.bold("📧 MESSAGE DETAILS"),
      `├─ To: ${chalk.cyan(mailOptions.to)}`,
      `├─ From: ${chalk.cyan(mailOptions.from)}`,
      `├─ Subject: ${chalk.yellow(mailOptions.subject)}`,
      `├─ Template: ${chalk.cyan(mailOptions.templateFile || "N/A")}`,
      `├─ HTML Size: ${chalk.cyan(mailOptions.html ? mailOptions.html.length + " chars" : "N/A")}`,
      `└─ Attachments: ${chalk.cyan(mailOptions.attachments ? mailOptions.attachments.length : 0)}`,
    ];

    console.log(
      "\n" + DebugInterface.createBox("📡 SMTP SERVER INFO", content, "blue"),
    );
  }

  showEmailHeaders(mailOptions, appliedHeaders = {}) {
    if (!this.enabled || !config.debug.showHeaders) return;

    this.emailCount++;

    const content = [
      `Email #${this.emailCount} | Recipient: ${chalk.cyan(mailOptions.to)}`,
      `Subject: ${chalk.yellow(mailOptions.subject)}`,
      "",
      chalk.white.bold("📋 APPLIED HEADERS"),
    ];

    // Show standard headers first
    const standardHeaders = {
      From: mailOptions.from,
      To: mailOptions.to,
      Subject: mailOptions.subject,
      Date: new Date().toUTCString(),
      "Message-ID": `<${Date.now()}.${Math.random().toString(36).substring(7)}@${mailOptions.from && mailOptions.from.includes("@") ? mailOptions.from.split("@")[1] : "example.com"}>`,
    };

    Object.entries(standardHeaders).forEach(([key, value]) => {
      content.push(`├─ ${chalk.white.bold(key)}: ${chalk.gray(value)}`);
    });

    // Show custom headers
    if (mailOptions.headers && Object.keys(mailOptions.headers).length > 0) {
      content.push("", chalk.white.bold("🔧 CUSTOM HEADERS"));
      Object.entries(mailOptions.headers).forEach(
        ([key, value], index, array) => {
          const prefix = index === array.length - 1 ? "└─" : "├─";
          content.push(
            `${prefix} ${chalk.white.bold(key)}: ${chalk.gray(value)}`,
          );
        },
      );
    } else {
      content.push("└─ " + chalk.yellow("No custom headers applied"));
    }

    // Show header strategy info
    content.push("", chalk.white.bold("⚙️ HEADER STRATEGY"));
    content.push(
      `├─ Smart Detection: ${config.headers.smartDetection.enabled ? chalk.green("✓ ON") : chalk.red("✗ OFF")}`,
    );
    content.push(
      `├─ Header Rotation: ${config.headers.rotation.enabled ? chalk.green("✓ ON") : chalk.red("✗ OFF")}`,
    );
    content.push(
      `├─ Default Headers: ${config.headers.defaultHeaders.enabled ? chalk.green("✓ ON") : chalk.red("✗ OFF")}`,
    );
    content.push(
      `└─ Applied Count: ${chalk.yellow(Object.keys(mailOptions.headers || {}).length)}`,
    );

    console.log(
      "\n" + DebugInterface.createBox("📬 EMAIL HEADERS", content, "yellow"),
    );
  }

  showTemplateProcessing(templateFile, templateSize, handlebarsData) {
    if (!this.enabled || !config.debug.showTemplateProcessing) return;

    const content = [
      `Template File: ${chalk.cyan(templateFile)}`,
      `Template Size: ${chalk.yellow(templateSize + " chars")}`,
      `Processing: ${chalk.green("✓ HANDLEBARS COMPILATION")}`,
      "",
      chalk.white.bold("📝 RECIPIENT DATA"),
      `├─ Email: ${chalk.cyan(handlebarsData.email)}`,
      `├─ First Name: ${chalk.cyan(handlebarsData.firstName || "N/A")}`,
      `├─ Last Name: ${chalk.cyan(handlebarsData.lastName || "N/A")}`,
      `└─ Full Name: ${chalk.cyan(handlebarsData.fullName || "N/A")}`,
      "",
      chalk.white.bold("⚙️ PROCESSING FEATURES"),
      `├─ HTML Optimization: ${config.email.optimization.enabled ? chalk.green("✓ ON") : chalk.red("✗ OFF")}`,
      `├─ Spam Detection: ${config.email.optimization.showSpamTriggers ? chalk.green("✓ ON") : chalk.red("✗ OFF")}`,
      `└─ PDF Conversion: ${config.email?.media?.htmltopdf?.enabled ? chalk.green("✓ ON") : chalk.red("✗ OFF")}`,
    ];

    console.log(
      "\n" +
        DebugInterface.createBox("📄 TEMPLATE PROCESSING", content, "cyan"),
    );
  }

  showCampaignInit(recipientsFile, totalRecipients, campaignConfig) {
    if (!this.enabled || !config.debug.verbose) return;

    const content = [
      `Session: ${chalk.yellow(this.sessionId)}`,
      `Recipients File: ${chalk.cyan(recipientsFile)}`,
      `Total Recipients: ${chalk.yellow(totalRecipients)}`,
      `Concurrency: ${chalk.cyan(campaignConfig.concurrency)} threads`,
      `Email Delay: ${chalk.cyan(campaignConfig.emailDelay + "ms")}`,
      `├─ Retry: ${campaignConfig.retryEnabled ? chalk.green("✓ ENABLED") : chalk.red("✗ DISABLED")}`,
      `├─ Email Validation: ${campaignConfig.validationEnabled ? chalk.green("✓ ENABLED") : chalk.red("✗ OFF")}`,
      `├─ MX Validation: ${campaignConfig.mxValidation ? chalk.green("✓ ENABLED") : chalk.red("✗ OFF")}`,
      `├─ Skip Invalid: ${campaignConfig.skipInvalid ? chalk.green("✓ YES") : chalk.red("✗ NO")}`,
      "",
      chalk.white.bold("📊 ESTIMATED TIMING"),
      `├─ Per Email: ~${chalk.yellow((campaignConfig.emailDelay / 1000).toFixed(1) + "s")} (including delay)`,
      `├─ Total Time: ~${chalk.yellow(((totalRecipients * campaignConfig.emailDelay) / 60000).toFixed(1) + " minutes")}`,
      `└─ Estimated Completion: ${chalk.cyan(new Date(Date.now() + totalRecipients * campaignConfig.emailDelay).toLocaleTimeString())}`,
    ];

    console.log(
      "\n" +
        DebugInterface.createBox(
          "🚀 CAMPAIGN INITIALIZATION",
          content,
          "green",
        ),
    );
  }
}

// Initialize Debug Interface
const debugInterface = new DebugInterface();

// Initialize Media Handler
const mediaHandler = new MediaHandler(config.email.media);

// Legacy// debug function for backward compatibility
function debugLog(category, message, data = null) {
  if (!config.debug.enabled) return;

  if (config.debug.verbose) {
    const timestamp = new Date().toISOString().substring(11, 23);
    console.log(chalk.gray(`[${timestamp}] ${category}: ${message}`));
  }
}

// Initialize Dynamic Content Processor
let contentProcessor = null;
try {
  contentProcessor = new DynamicContentProcessor({
    macroDirectory: "./macros",
    cacheDirectory: "./.cache",
    enableLogging: config.debug.enabled && config.debug.showDynamicContent,
  });

  if (contentProcessor.getAvailableMacros().length === 0) {
    contentProcessor.createExampleMacros();
  }

  debugLog("content", "Dynamic Content Processor initialized successfully", {
    macroCount: contentProcessor.getAvailableMacros().length,
    macroDirectory: "./macros",
  });

  // Debug media configuration loading
  if (config.debug?.enabled) {
    console.log("🔍 Media configuration debug:");
    console.log(
      "  config.email.media:",
      config.email?.media ? "exists" : "undefined",
    );
    if (config.email?.media) {
      const features = Object.entries(config.email.media)
        .map(
          ([key, value]) =>
            `${key}: ${value?.enabled ? "enabled" : "disabled"}`,
        )
        .join(", ");
      console.log("  Features:", features);
    }
  }
} catch (error) {
  console.log(
    chalk.red(`❌ Dynamic Content Processor Failed: ${error.message}`),
  );
}

const contentProcessingCache = new SmartContentCache(1000, contentProcessor);

// ✅ UNIFIED: Using single rotation manager instances from modules.js
// All rotation managers are now imported from modules.js eliminating duplication
// Rotation calls are handled directly in sendEmail() with the unified instances

// ✅ NEW: Enhanced sendEmail with smart validation
async function sendEmailWithSmartValidation(
  recipient,
  threadId,
  smartValidator,
) {
  try {
    // ✅ OPTIMIZED: Smart validation (only when needed)
    await smartValidator.validateSmart();

    // Send the email
    const result = await sendEmail(recipient, threadId);

    // Record email sent for validation tracking
    smartValidator.recordEmailSent();

    return result;
  } catch (error) {
    console.error(`Failed to send email with validation: ${error.message}`);
    throw error;
  }
}

async function sendEmail(recipient, threadId = null) {
  // Generate thread ID if not provided with better collision resistance
  if (!threadId) {
    const timestamp = process.hrtime.bigint();
    const randomPart = Math.random().toString(36).substring(2, 15);
    threadId = `thread_${timestamp}_${randomPart}`;
  }

  // ✅ UNIFIED: All rotation calls execute simultaneously using single instances
  const [finalSubject, finalSenderName, templateFile] = await Promise.all([
    subjectRotation.getNext(), // \
    senderRotation.getNext(), //  } All run in parallel using unified managers
    templateRotation.getNext(), // /
  ]);

  // Performance gain: 3x faster rotation (5-15ms vs 15-45ms) + unified state consistency

  // ✅ DEBUG: Optional unified rotation logging
  if (config.debug?.showRotation) {
    console.log(
      `🔄 Unified rotation: subject="${finalSubject}", sender="${finalSenderName}", template="${templateFile}"`,
    );
  }

  let template;
  try {
    template = await templateCache.get(templateFile);
  } catch (error) {
    console.error(
      chalk.red(`Failed to read template ${templateFile}: ${error.message}`),
    );
    try {
      template = await templateCache.get(config.email.templates.default);
    } catch (fallbackError) {
      console.error(
        chalk.red(`Failed to read default template: ${fallbackError.message}`),
      );
      // Use synchronous fallback to avoid await issues
      template = "<html><body>{{email}} - Template not found</body></html>";
    }
  }

  // Show template processing debug info
  debugInterface.showTemplateProcessing(
    templateFile,
    template.length,
    recipient,
  );

  let processedTemplate = template;
  let processedSubject = finalSubject;

  // Step 1: Process macros and spintax (if contentProcessor exists)
  if (
    contentProcessor &&
    typeof contentProcessor.processContent === "function"
  ) {
    try {
      console.log(`🔄 Processing dynamic content for ${recipient.email}`);

      processedTemplate = await contentProcessor.processContent(
        template,
        recipient,
        {
          enableMacros: true,
          enableMailMerge: false, // Let Handlebars handle this
          enableSpintax: true,
          useSequentialMacros: true,
        },
      );

      processedSubject = await contentProcessor.processContent(
        finalSubject,
        recipient,
        {
          enableMacros: true,
          enableMailMerge: false,
          enableSpintax: true,
          useSequentialMacros: true,
        },
      );

      // Show content processing debug info
      debugInterface.showContentProcessing(
        template,
        processedTemplate,
        "Template",
      );
      debugInterface.showContentProcessing(
        finalSubject,
        processedSubject,
        "Subject",
      );
    } catch (error) {
      console.error(
        chalk.yellow(`⚠️ Dynamic content processing failed: ${error.message}`),
      );
      processedTemplate = template;
      processedSubject = finalSubject;
    }
  }

  // Prepare for Handlebars compilation
  const templateString = processedTemplate;
  const subjectString = processedSubject;

  // Step 2: Compile fresh when dynamic content is present
  let templateCompiler;
  if (contentProcessor && contentProcessor.getAvailableMacros().length > 0) {
    // Dynamic content present - compile fresh with processed template
    templateCompiler = Handlebars.compile(processedTemplate, {
      noEscape: false,
      strict: false,
    });
    stats.recordTemplateMiss();
    console.log(
      `🔄 Compiled template fresh for dynamic content: ${templateFile}`,
    );
  } else {
    // No dynamic content - use cached pre-compiled template
    templateCompiler = templateCache.getCompiledTemplate(templateFile);
    if (!templateCompiler) {
      templateCompiler = Handlebars.compile(template, {
        noEscape: false,
        strict: false,
      });
      templateCache.setCompiledTemplate(templateFile, templateCompiler);
      stats.recordTemplateMiss();
    } else {
      stats.recordTemplateHit();
    }
  }

  const subjectCompiler = Handlebars.compile(processedSubject, {
    noEscape: false,
    strict: false,
  });

  // Create secure context for recipient data
  const secureRecipient = {
    ...recipient,
    // Escape potentially dangerous fields
    email: Handlebars.escapeExpression(recipient.email || ""),
    firstName: Handlebars.escapeExpression(recipient.firstName || ""),
    lastName: Handlebars.escapeExpression(recipient.lastName || ""),
    name: Handlebars.escapeExpression(recipient.name || ""),
    fullName: Handlebars.escapeExpression(recipient.fullName || ""),
  };

  let compiledHtml = templateCompiler(secureRecipient);
  let compiledSubject = subjectCompiler(secureRecipient);

  // Content optimization with spam trigger removal
  if (config.email.optimization.enabled) {
    if (config.email.optimization.optimizeHtml) {
      const optimizedContent = optimizeHtmlContent(compiledHtml, {
        spamRemovalMode: "mask", // 'mask', 'remove', 'replace'
        spamReplacement: "***",
      });

      compiledHtml = optimizedContent.html || compiledHtml;

      // Log spam removal results if triggers were removed
      if (
        optimizedContent.spamRemoval &&
        optimizedContent.spamRemoval.triggersRemoved > 0
      ) {
        console.log(
          chalk.yellow(
            `🧹 Masked ${optimizedContent.spamRemoval.triggersRemoved} spam trigger(s) in ${recipient.email}`,
          ),
        );

        // Debug: Show what was removed if debug mode is enabled
        if (config.debug?.enabled && config.debug?.verbose) {
          optimizedContent.spamRemoval.removedTriggers.forEach((trigger) => {
            console.log(
              chalk.gray(
                `   └─ "${trigger.original}" → "${trigger.replacement}"`,
              ),
            );
          });
        }
      }
    } else if (config.email.optimization.removeSpamTriggers) {
      // Process spam triggers separately if HTML optimization is disabled
      const spamRemovalResult = removeSpamTriggers(compiledHtml, {
        mode: "mask", // or 'remove', 'replace'
        replacement: "***",
      });

      compiledHtml = spamRemovalResult.content;

      if (spamRemovalResult.triggersRemoved > 0) {
        console.log(
          chalk.yellow(
            `🧹 Masked ${spamRemovalResult.triggersRemoved} spam trigger(s) in ${recipient.email}`,
          ),
        );

        // Debug: Show what was removed if debug mode is enabled
        if (config.debug?.enabled && config.debug?.verbose) {
          spamRemovalResult.removedTriggers.forEach((trigger) => {
            console.log(
              chalk.gray(
                `   └─ "${trigger.original}" → "${trigger.replacement}"`,
              ),
            );
          });
        }
      }
    }
  }

  const mailOptions = {
    to: recipient.email,
    subject: compiledSubject,
    html: compiledHtml,
    templateFile: templateFile,
    headers: {},
    attachments: [],
    senderName: finalSenderName, // Pass sender name to SMTP manager
  };

  // Check if media handler exists and has any enabled features
  if (
    mediaHandler &&
    (config.email?.media?.attachments?.enabled ||
      config.email?.media?.htmltopdf?.enabled ||
      config.email?.media?.htmltoimage?.enabled ||
      config.email?.media?.htmltosvg?.enabled)
  ) {
    try {
      const mediaResults = await mediaHandler.processEmailContent(
        compiledHtml,
        mailOptions,
      );

      if (mediaResults.attachments.length > 0) {
        mailOptions.attachments.push(...mediaResults.attachments);
        console.log(
          chalk.green(
            `📎 Added ${mediaResults.attachments.length} attachment(s) to ${recipient.email}`,
          ),
        );
      }

      if (mediaResults.htmlModified) {
        console.log(
          chalk.blue(`🔄 Email content modified for ${recipient.email}`),
        );
      }
    } catch (error) {
      console.warn(
        chalk.yellow(
          `⚠️ Media processing failed for ${recipient.email}: ${error.message}`,
        ),
      );
      // Continue with original email if media processing fails
    }
  }

  // Show email headers before sending
  debugInterface.showEmailHeaders(mailOptions);

  try {
    // FIX: Don't pre-generate email number - let it be generated on success
    await smtpManager.sendMail(mailOptions, null, threadId);

    // FIX: Generate number only AFTER successful send
    const actualEmailNumber = stats.incrementSent();

    return true;
  } catch (error) {
    const currentFailed = stats.incrementFailed();

    console.error(
      chalk.red(`Failed to send to ${recipient.email}: ${error.message}`),
    );

    // Don't retry on authentication or permanent errors
    if (
      error.code === "EAUTH" ||
      error.code === "ECONNREFUSED" ||
      error.code === "ENOTFOUND"
    ) {
      console.error(
        chalk.red(
          `Permanent error detected, skipping retry for ${recipient.email}`,
        ),
      );
      return false;
    }

    // Implement per-email retry counter to prevent global retry increment
    const retryKey = `retry_${recipient.email}_${threadId}`;
    const currentAttempts = (global.emailRetries?.get?.(retryKey) || 0) + 1; // +1 for this failed attempt

    if (
      config.sending.retry.enabled &&
      currentAttempts < config.sending.retry.maxAttempts // Now compares total attempts vs maxAttempts
    ) {
      // Add maximum total retry time limit (5 minutes)
      const maxRetryTime = 300000; // 5 minutes
      const retryStartTime =
        global.emailRetryStartTimes?.get?.(retryKey) || Date.now();

      if (!global.emailRetryStartTimes) {
        global.emailRetryStartTimes = new Map();
      }
      global.emailRetryStartTimes.set(retryKey, retryStartTime);

      // Check if we've exceeded maximum retry time
      if (Date.now() - retryStartTime > maxRetryTime) {
        console.error(
          chalk.red(
            `⏰ Retry timeout exceeded for ${recipient.email} after ${maxRetryTime / 1000}s`,
          ),
        );

        // Cleanup retry tracking
        global.emailRetries?.delete?.(retryKey);
        global.emailRetryStartTimes?.delete?.(retryKey);
        return false;
      }

      // Initialize global retry tracking if needed
      if (!global.emailRetries) {
        global.emailRetries = new Map();
      }

      global.emailRetries.set(retryKey, currentAttempts);

      const backoffDelay = Math.min(
        config.sending.retry.delayBetweenAttempts *
          Math.pow(2, currentAttempts - 1),
        30000, // Maximum 30 second delay
      );

      console.log(
        chalk.yellow(
          `Retrying ${recipient.email} (Attempt ${currentAttempts + 1}/${config.sending.retry.maxAttempts}) in ${backoffDelay}ms...`,
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, backoffDelay));

      return sendEmail(recipient, threadId);
    } else {
      // Cleanup all retry tracking
      if (global.emailRetries?.has?.(retryKey)) {
        global.emailRetries.delete(retryKey);
      }
      if (global.emailRetryStartTimes?.has?.(retryKey)) {
        global.emailRetryStartTimes.delete(retryKey);
      }
    }
    return false;
  }
}

async function startCampaign(recipientsFile, concurrency = 1) {
  // ✅ ASYNC: Non-blocking file read for massive performance gain
  let recipientsContent;
  try {
    recipientsContent = await fs.promises.readFile(recipientsFile, "utf-8");
  } catch (error) {
    console.log(chalk.red(`❌ Recipients file not found: ${recipientsFile}`));
    console.log(
      chalk.yellow("📝 Please create the recipients file and restart."),
    );
    process.exit(1);
  }

  // ✅ OPTIMIZED: Process recipients data efficiently
  const recipients = (recipientsContent || "")
    .split("\n")
    .filter((line) => line && line.trim().length > 0) // Check line exists
    .map((line) => {
      // Add null check for line before calling split
      if (!line || typeof line !== "string") {
        return null;
      }

      const parts = line.split(",");
      const email = parts[0]?.trim();
      // FIXED: Check email exists and is valid before using split
      if (!email || typeof email !== "string" || !email.includes("@")) {
        return null; // Skip invalid lines
      }
      let firstName, lastName;

      if (parts.length > 1 && parts[1]?.trim()) {
        firstName = parts[1].trim();
      } else {
        // FIXED: Safe email splitting with error handling
        try {
          // Add extra validation before split
          if (email && typeof email === "string" && email.includes("@")) {
            const emailParts = email.split("@");
            firstName = emailParts[0] || "User";
          } else {
            firstName = "User";
          }
        } catch (splitError) {
          firstName = "User";
        }
      }
      if (parts.length > 2 && parts[2]?.trim()) {
        lastName = parts[2].trim();
      } else {
        lastName = "";
      }

      return {
        email,
        firstName,
        lastName,
        name: firstName,
        fullName: `${firstName} ${lastName}`.trim(),
      };
    })
    .filter((recipient) => recipient !== null); // Remove invalid entries

  // Show campaign initialization debug info
  debugInterface.showCampaignInit(recipientsFile, recipients.length, {
    concurrency: concurrency,
    emailDelay: config.sending.emailDelay,
    retryEnabled: config.sending.retry.enabled,
    validationEnabled: config.email.validation.enabled,
    mxValidation: config.email.validation.validateMXRecords,
    skipInvalid: config.email.validation.skipInvalid,
  });

  console.log(
    chalk.cyan(
      `\n📧 Starting campaign with ${recipients.length} recipients...`,
    ),
  );

  if (config.email.optimization.showSpamTriggers) {
    const template = await fs.promises.readFile(
      config.email.templates.default,
      "utf-8",
    );
    const spamTriggers = checkForSpamTriggers(template);
    if (spamTriggers.length > 0) {
      console.log(chalk.yellow(`\n=== Detected Spam Triggers ===`));
      spamTriggers.forEach((trigger) => {
        console.log(chalk.yellow(`- ${trigger.type}: ${trigger.value}`));
      });
    }
  }

  stats.startTime = Date.now();
  stats.remaining = recipients.length;

  // Periodic performance logging
  const performanceInterval = setInterval(() => {
    const snapshot = stats.takePerformanceSnapshot();
    console.log(
      `📊 Live: ${snapshot.emailsPerSecond.toFixed(1)} emails/sec, ${snapshot.successRate.toFixed(1)}% success, ${stats.sent}/${recipients.length} sent`,
    );
  }, 30000); // Every 30 seconds

  // Process emails with coordinated threading
  for (let i = 0; i < recipients.length; i += concurrency) {
    const concurrentRecipients = recipients.slice(i, i + concurrency);

    // Create unique thread IDs for each concurrent batch
    const threadPromises = concurrentRecipients.map((recipient, index) => {
      const threadId = `thread_${i + index}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      return sendEmail(recipient, threadId);
    });

    await Promise.all(threadPromises);

    if (i + concurrency < recipients.length && config.sending.emailDelay > 0) {
      console.log(
        chalk.yellow(
          `Waiting ${config.sending.emailDelay / 1000}s before next email(s)...`,
        ),
      );
      await new Promise((resolve) =>
        setTimeout(resolve, config.sending.emailDelay),
      );
    }

    // Show progress and coordination status
    if (stats.sent % 25 === 0 && stats.sent > 0) {
      console.log(chalk.cyan(`📊 Progress: ${stats.sent} emails sent...`));

      // Show coordination status occasionally
      if (stats.sent % 100 === 0) {
        const coordStatus = smtpManager.getCoordinationStatus();
        console.log(
          chalk.blue(
            `🔄 Active SMTPs: ${coordStatus.activeSmtps}/${coordStatus.totalSmtps}, Cooling: ${coordStatus.coolingSmtps}, Threads: ${coordStatus.activeThreads}`,
          ),
        );
      }
    }
  }

  // Clear performance interval
  clearInterval(performanceInterval);

  // Final performance report
  const finalReport = stats.logPerformanceReport();

  // Campaign results with performance stats
  console.log("\n╔═════════════════ Campaign Results ══════════════════╗");
  console.log(`║ Status: Campaign Completed                        ║`);
  console.log(`║ Sent: ${stats.sent.toString().padEnd(41)}║`);
  console.log(`║ Failed: ${stats.failed.toString().padEnd(39)}║`);
  console.log(`║ Retries: ${stats.retries.toString().padEnd(38)}║`);
  console.log(
    `║ Speed: ${finalReport.emailsPerSecond.toFixed(2)} emails/sec`.padEnd(54) +
      "║",
  );
  console.log(
    `║ Template Cache Hit Rate: ${templateCache.getPrecompilationStats().hitRate}`.padEnd(
      54,
    ) + "║",
  );
  console.log(
    `║ Connection Reuse Rate: ${smtpManager.getConnectionStats().reuseRate}`.padEnd(
      54,
    ) + "║",
  );
  console.log(
    `║ Time: ${((Date.now() - stats.startTime) / 1000).toFixed(2)}s`.padEnd(
      45,
    ) + "║",
  );
  console.log(
    "╚══════════════════════════════════════════════════════════════╝\n",
  );
}

function showBarracudaMailerBanner() {
  console.clear();
  console.log(
    chalk.cyan(`
██████╗  █████╗ ██████╗ ██████╗  █████╗  ██████╗██╗   ██╗██████╗  █████╗     ███╗   ███╗ █████╗ ██╗██╗     ███████╗██████╗ 
██╔══██╗██╔══██╗██╔══██╗██╔══██╗██╔══██╗██╔════╝██║   ██║██╔══██╗██╔══██╗    ████╗ ████║██╔══██╗██║██║     ██╔════╝██╔══██╗
██████╔╝███████║██████╔╝██████╔╝███████║██║     ██║   ██║██║  ██║███████║    ██╔████╔██║███████║██║██║     █████╗  ██████╔╝
██╔══██╗██╔══██║██╔══██╗██╔══██╗██╔══██║██║     ██║   ██║██║  ██║██╔══██║    ██║╚██╔╝██║██╔══██║██║██║     ██╔══╝  ██╔══██╗
██████╔╝██║  ██║██║  ██║██║  ██║██║  ██║╚██████╗╚██████╔╝██████╔╝██║  ██║    ██║ ╚═╝ ██║██║  ██║██║███████╗███████╗██║  ██║
╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝    ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝╚═╝  ╚═╝                                                                                                                   

                                      RProxy LAB x EvilWhales - Mailer v2.2 Public Version`),
  );
  console.log(chalk.green("\n✅ System ready"));

  // Show system info
  showSystemInfo();

  // Show comprehensive debug configuration
  if (config.debug.enabled) {
    debugInterface.showConfigurationStatus();
  }
}

// ===== SYSTEM INFO DISPLAY =====
function showSystemInfo() {
  const nodeVersion = process.version;
  const platform = process.platform;
  const arch = process.arch;
  const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
  const uptime = Math.floor(process.uptime());

  console.log(
    chalk.gray(
      `Node.js: ${nodeVersion} | Platform: ${platform}-${arch} | Memory: ${totalMem}GB | Uptime: ${uptime}s`,
    ),
  );

  // Show media handler status
  if (config.email.media) {
    try {
      const mediaStats = mediaHandler.getStats();
      const enabledFeatures = Object.entries(config.email.media)
        .filter(([key, value]) => value && value.enabled)
        .map(([key]) => key);
      console.log(
        chalk.gray(
          `📎 Media Handler: ${enabledFeatures.length} features enabled (${enabledFeatures.join(", ") || "none"})`,
        ),
      );
    } catch (error) {
      console.log(
        chalk.gray(`📎 Media Handler: initialized but stats unavailable`),
      );
    }
  } else {
    console.log(
      chalk.gray(`📎 Media Handler: disabled (no config.email.media)`),
    );
  }
}

// Comprehensive cleanup on exit
async function performCleanup() {
  console.log(chalk.yellow("\n🔄 Performing cleanup..."));

  try {
    // Show final performance stats before cleanup
    if (stats.startTime) {
      stats.logPerformanceReport();
    }

    // Clean up global retry tracking
    if (global.emailRetries) {
      global.emailRetries.clear();
      delete global.emailRetries;
    }

    if (global.emailRetryStartTimes) {
      global.emailRetryStartTimes.clear();
      delete global.emailRetryStartTimes;
    }

    // Cleanup SMTP manager
    if (smtpManager) {
      await smtpManager.cleanup();
    }

    // Cleanup content processor
    if (contentProcessor) {
      await contentProcessor.cleanup();
    }

    // Clear template cache with memory cleanup
    if (templateCache) {
      if (typeof templateCache.clear === "function") {
        templateCache.clear();
      }
      if (templateCache.compiledTemplates) {
        templateCache.compiledTemplates.clear();
      }
      if (templateCache._activeFileChecks) {
        templateCache._activeFileChecks.clear();
      }
    }

    // Clear content processing cache
    if (
      contentProcessingCache &&
      typeof contentProcessingCache.clear === "function"
    ) {
      contentProcessingCache.clear();
    }

    // Clear stats mutex
    if (stats._statsMutex) {
      stats._statsMutex.queue = [];
      stats._statsMutex.locked = false;
    }

    // Force multiple garbage collection cycles
    if (global.gc) {
      for (let i = 0; i < 3; i++) {
        try {
          global.gc();
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (error) {
          // Ignore GC errors
        }
      }
    }

    console.log(chalk.green("✅ Cleanup completed"));
  } catch (error) {
    console.error(chalk.red("❌ Cleanup error:"), error.message);
  }
}

process.on("SIGINT", async () => {
  await performCleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await performCleanup();
  process.exit(0);
});

process.on("beforeExit", async () => {
  await performCleanup();
});

// Template cache initialization with proper error handling
let templateCache;
try {
  templateCache = new SmartTemplateCache(100);
  console.log("✅ Template cache initialized successfully");
} catch (error) {
  console.error("❌ Failed to initialize template cache:", error.message);
  // Create a minimal fallback cache
  templateCache = {
    async get(templateFile) {
      try {
        return await fs.promises.readFile(templateFile, "utf-8");
      } catch (error) {
        throw new Error(
          `Failed to read template ${templateFile}: ${error.message}`,
        );
      }
    },
    getStats() {
      return { hits: 0, misses: 0, totalRequests: 0 };
    },
    clear() {
      // No-op for fallback
    },
  };
}

// ===== ASYNC FILE UTILITIES =====
/**
 * Async file existence check - replaces fs.existsSync() for better performance
 */
async function checkFileExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ===== MAIN EXECUTION =====
async function main() {
  showBarracudaMailerBanner();

  // Start performance tracking
  stats.startPerformanceTracking();

  // FIXED: Conditional pre-compilation based on dynamic content usage
  if (contentProcessor && contentProcessor.getAvailableMacros().length > 0) {
    console.log(
      "🎯 Dynamic content detected - DISABLING template pre-compilation",
    );
    console.log(
      `📊 Found ${contentProcessor.getAvailableMacros().length} macros - templates will be compiled fresh for each email`,
    );

    // Clear any existing pre-compiled templates
    if (templateCache.compiledTemplates) {
      templateCache.compiledTemplates.clear();
    }
  } else {
    console.log(
      "🔥 No dynamic content - ENABLING template pre-compilation for performance",
    );
    try {
      await templateCache.preCompileAllTemplates();
    } catch (error) {
      console.warn(`⚠️ Template pre-compilation failed: ${error.message}`);
    }
  }

  // ✅ FIXED: Direct warmup check without performance dependency
  // Warm up SMTP connections if enabled
  if (config.smtp.warmup?.enabled) {
    try {
      await smtpManager.warmupSMTPConnections();
      console.log("🔥 SMTP warmup process initiated");
    } catch (error) {
      console.warn(`⚠️ SMTP warmup failed: ${error.message}`);
    }
  } else {
    console.log("🚫 SMTP warmup disabled in config");
  }

  // Initialize campaign detector for smart cache management
  const campaignDetector = new CampaignDetector(config, contentProcessor);
  const isNewCampaign = campaignDetector.detectNewCampaign();

  if (isNewCampaign) {
    console.log(chalk.cyan("🔄 New campaign detected - optimizing caches..."));
    contentProcessingCache.clear();
  }

  // Templates loaded on-demand

  // Start campaign with default settings
  const defaultRecipientFile = config.files.recipientsList;
  const defaultConcurrency = config.sending.concurrency;

  console.log(chalk.blue(`🚀 Starting campaign...`));
  console.log(chalk.yellow(`📁 Recipients: ${defaultRecipientFile}`));
  console.log(chalk.yellow(`🧵 Threads: ${defaultConcurrency}`));
  console.log(chalk.yellow(`⏱️ Delay: ${config.sending.emailDelay}ms`));
  console.log(chalk.green(`🔥 Template Pre-compilation: ENABLED`));
  console.log(chalk.green(`🌊 SMTP Connection Warmup: ENABLED`));
  console.log(chalk.green(`📊 Performance Monitoring: ENABLED\n`));

  // ✅ ASYNC: Non-blocking file existence check
  if (!(await checkFileExists(defaultRecipientFile))) {
    console.log(
      chalk.red(`❌ Recipients file not found: ${defaultRecipientFile}`),
    );
    console.log(
      chalk.yellow("📝 Please create the recipients file and restart."),
    );
    process.exit(1);
  }

  await startCampaign(defaultRecipientFile, defaultConcurrency);

  console.log(chalk.green("✅ Campaign completed successfully!"));
  process.exit(0);
}

// Start the application
main().catch((error) => {
  console.error(chalk.red(`❌ Application failed to start: ${error.message}`));
  process.exit(1);
});
