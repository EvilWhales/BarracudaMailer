// ===== EXTERNAL IMPORTS =====
import nodemailer from "nodemailer";
import dns from "dns";
import chalk from "chalk";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";

import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

// ===== CONFIGURATION IMPORT =====
import config from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== THREAD SAFETY UTILITIES =====
class AsyncMutex {
  constructor() {
    this.locked = false;
    this.queue = [];
  }

  async acquire(timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.locked) {
        this.locked = true;
        resolve();
      } else {
        const entry = { resolve, reject, timeoutId: null };

        const timeoutId = setTimeout(() => {
          const index = this.queue.indexOf(entry);
          if (index > -1) {
            this.queue.splice(index, 1);
            reject(new Error("Mutex acquire timeout"));
          }
        }, timeout);

        entry.timeoutId = timeoutId;
        this.queue.push(entry);
      }
    });
  }

  release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next.timeoutId) {
        clearTimeout(next.timeoutId);
      }
      next.resolve();
    } else {
      this.locked = false;
    }
  }
}

// LRU Cache implementation for memory management
class LRUCache {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.cache = new Map();
    this._accessCount = 0;
    this._cleanupThreshold = Math.floor(maxSize * 0.1); // Clean up when 10% over limit
  }

  get(key) {
    if (this.cache.has(key)) {
      const value = this.cache.get(key);
      // Only move to end if not recently accessed (reduces Map operations)
      this._accessCount++;
      if (this._accessCount % 5 === 0) {
        this.cache.delete(key);
        this.cache.set(key, value);
      }
      return value;
    }
    return undefined;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Batch cleanup instead of one-by-one
      this._batchCleanup();
    }
    this.cache.set(key, value);
  }

  _batchCleanup() {
    const deleteCount = this._cleanupThreshold;
    const keysToDelete = Array.from(this.cache.keys()).slice(0, deleteCount);
    for (const key of keysToDelete) {
      this.cache.delete(key);
    }
  }

  has(key) {
    return this.cache.has(key);
  }

  delete(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
    this._accessCount = 0;
  }

  get size() {
    return this.cache.size;
  }
}

// ===== ROTATION MANAGER CLASS (FIXED) =====
class RotationManager {
  constructor(items, name = "generic", config = null) {
    if (!Array.isArray(items)) {
      throw new Error(
        `Invalid items provided to RotationManager: expected array, got ${typeof items}`,
      );
    }

    if (!name || typeof name !== "string") {
      throw new Error("Invalid name: must be a non-empty string");
    }

    this.items = items.filter((item) => item !== null && item !== undefined);
    this.name = name;
    this.currentIndex = 0;
    this.usageStats = {};

    // Thread safety
    this.mutex = new AsyncMutex();

    this.config = config || {};
    this.rotationStrategy = this.getRotationStrategy();

    // Memory-only initialization
    this.initPromise = this.init();
  }

  async init() {}

  getRotationStrategy() {
    const configMappings = {
      smtp: this.config?.smtp?.rotation,
      templates: this.config?.email?.templates?.rotation,
      template: this.config?.email?.templates?.rotation,
      letters: this.config?.email?.templates?.rotation,
      senderName: this.config?.email?.senderName?.rotation,
      senderNames: this.config?.email?.senderName?.rotation,
      subject: this.config?.email?.subject?.rotation,
      subjects: this.config?.email?.subject?.rotation,
      headers: this.config?.headers?.rotation,
      proxy: this.config?.proxy?.rotation,
    };

    const rotationConfig =
      configMappings[this.name] ||
      configMappings[this.name.toLowerCase()] ||
      this.config?.rotation;

    // ✅ FIXED: Handle all cases properly
    if (!rotationConfig) {
      return "sequential"; // No config found, default to sequential
    }

    // Explicitly disabled
    if (rotationConfig.enabled === false) {
      return "disabled";
    }

    // Enabled OR undefined (default behavior)
    if (
      rotationConfig.enabled === true ||
      rotationConfig.enabled === undefined
    ) {
      const strategy = rotationConfig.strategy || "sequential";
      switch (strategy.toLowerCase()) {
        case "round-robin":
        case "sequential":
          return "sequential";
        case "random":
          return "random";
        default:
          return "sequential";
      }
    }

    // Fallback
    return "sequential";
  }

  async getNext(forceStrategy = null) {
    await this.initPromise;

    if (!this.items || !this.items.length) {
      throw new Error(
        `No ${this.name} items available. Check configuration for ${this.name}.`,
      );
    }

    const strategy = forceStrategy || this.rotationStrategy;
    let item;

    // Always use mutex for thread safety, regardless of strategy
    await this.mutex.acquire();
    try {
      if (strategy === "disabled") {
        item = this.items[0]; // Always return first item when rotation is disabled
      } else if (strategy === "random") {
        // Proper random selection with bounds checking
        const randomIndex = Math.floor(Math.random() * this.items.length);
        item = this.items[randomIndex];
        // Don't increment currentIndex for random strategy
      } else {
        // FIX: Comprehensive bounds checking for sequential
        if (this.currentIndex >= this.items.length || this.currentIndex < 0) {
          this.currentIndex = 0;
        }

        // FIX: Ensure index is within bounds
        const safeIndex = Math.max(
          0,
          Math.min(this.currentIndex, this.items.length - 1),
        );
        item = this.items[safeIndex];

        // FIX: Safe increment with wraparound
        this.currentIndex = (safeIndex + 1) % this.items.length;
      }

      // FIX: Final validation
      if (item === null || item === undefined) {
        console.warn(
          `⚠️ Invalid item selected for ${this.name}, using first item`,
        );
        item = this.items[0] || "";
      }

      // Update usage stats inside mutex for thread safety
      const key = typeof item === "string" ? item : JSON.stringify(item);
      this.usageStats[key] = (this.usageStats[key] || 0) + 1;

      // Prevent memory leak - smart cleanup preserving important data
      if (Object.keys(this.usageStats).length > 1000) {
        // Keep top 100 most used items
        const topItems = Object.entries(this.usageStats)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 100);

        const originalCount = Object.keys(this.usageStats).length;
        this.usageStats = Object.fromEntries(topItems);

        // Ensure current item is preserved
        if (!this.usageStats[key]) {
          this.usageStats[key] = 1;
        }

        console.warn(
          `⚠️ ${this.name} usage stats trimmed to top 100 items (was ${originalCount})`,
        );
      }

      // Add debug logging when debug mode is enabled (optimized)
      if (this.config?.debug?.showRotation) {
        const displayItem =
          typeof item === "string" ? item : JSON.stringify(item);
        const truncatedItem =
          displayItem.length > 50
            ? displayItem.substring(0, 50) + "..."
            : displayItem;
        console.log(
          `🔄 ${this.name} rotation: strategy=${strategy}, selected="${truncatedItem}"`,
        );
      }
    } finally {
      this.mutex.release();
    }

    // Always return the actual item, ensure it's the correct type
    return item;
  }

  async getSequential() {
    return await this.getNext("sequential");
  }

  async getRandom() {
    return await this.getNext("random");
  }

  getCurrentItem() {
    if (!this.items.length) return null;
    return this.items[this.currentIndex];
  }

  async reset() {
    await this.mutex.acquire();
    try {
      this.currentIndex = 0;
      this.usageStats = {};
    } finally {
      this.mutex.release();
    }
  }

  getStatus() {
    return {
      name: this.name,
      strategy: this.rotationStrategy,
      totalItems: this.items.length,
      currentIndex: this.currentIndex,
      nextItem: this.getCurrentItem(),
    };
  }

  async setItems(newItems) {
    await this.mutex.acquire();
    try {
      this.items = newItems || [];
      this.currentIndex = 0;
    } finally {
      this.mutex.release();
    }
  }

  async cleanup() {
    // No specific cleanup needed for RotationManager
  }
}

// ===== DYNAMIC CONTENT PROCESSOR CLASS (FIXED) =====
class DynamicContentProcessor {
  constructor(options = {}) {
    this.macroDirectory =
      options.macroDirectory || path.join(__dirname, "macros");
    this.cacheDirectory =
      options.cacheDirectory || path.join(__dirname, ".cache");
    this.enableLogging = options.enableLogging !== false;

    // Fixed: Use smaller LRU cache with memory monitoring
    this.macroCache = new LRUCache(100);
    this.macroFiles = new Map();
    this.usageStats = {
      macrosProcessed: 0,
      spintaxProcessed: 0,
      mailMergeProcessed: 0,
      totalProcessed: 0,
    };

    this.macroRotationState = new Map();

    // Thread safety
    this.mutex = new AsyncMutex();
    this.fileOperationMutex = new AsyncMutex();

    this.initPromise = this.init();
  }

  async init() {
    try {
      await this.ensureDirectories();
      await this.loadMacroFiles();

      if (this.enableLogging) {
        console.log(`✅ Dynamic Content Processor initialized`);
        console.log(`📁 Macro directory: ${this.macroDirectory}`);
        console.log(`📊 Found ${this.macroFiles.size} macro files`);
      }
    } catch (error) {
      console.error(
        `❌ Failed to initialize Dynamic Content Processor: ${error.message}`,
      );
      throw error;
    }
  }

  async ensureDirectories() {
    const directories = [this.macroDirectory, this.cacheDirectory];
    for (const dir of directories) {
      try {
        await fs.promises.access(dir);
      } catch {
        try {
          await fs.promises.mkdir(dir, { recursive: true });
        } catch (error) {
          // Silent fail if directory creation fails
          console.warn(`Directory creation failed: ${error.message}`);
        }
      }
    }
  }

  async loadMacroFiles() {
    await this.fileOperationMutex.acquire();
    try {
      let files = [];
      try {
        await fs.promises.access(this.macroDirectory);
        files = await fs.promises.readdir(this.macroDirectory);
      } catch {
        return; // Directory doesn't exist
      }

      const macroFiles = files.filter(
        (file) =>
          file.toUpperCase().startsWith("MACRO") && file.endsWith(".txt"),
      );

      this.macroFiles.clear();
      this.macroCache.clear();

      for (const file of macroFiles) {
        try {
          const filePath = path.join(this.macroDirectory, file);
          const macroName = this.extractMacroName(file);

          if (macroName) {
            this.macroFiles.set(macroName, filePath);
            await this.loadMacroContent(macroName, filePath);
          }
        } catch (error) {
          console.error(
            `❌ Failed to load macro file ${file}: ${error.message}`,
          );
        }
      }
    } finally {
      this.fileOperationMutex.release();
    }
  }

  extractMacroName(filename) {
    const match = filename.match(/^MACRO(\d+)\.txt$/i);
    return match ? `MACRO${match[1]}` : null;
  }

  async loadMacroContent(macroName, filePath) {
    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const lines = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));

      if (lines.length === 0) {
        console.warn(
          `⚠️ Macro file ${macroName} is empty or contains no valid content`,
        );
        return;
      }

      const stats = await fs.promises.stat(filePath);
      this.macroCache.set(macroName, {
        content: lines,
        filePath: filePath,
        lastModified: stats.mtime,
        totalItems: lines.length,
        currentIndex: 0,
      });

      if (!this.macroRotationState.has(macroName)) {
        this.macroRotationState.set(macroName, { index: 0 });
      }
    } catch (error) {
      console.error(
        `❌ Failed to load content for ${macroName}: ${error.message}`,
      );
    }
  }

  async getNextMacroItem(macroName) {
    await this.initPromise; // Ensure initialization is complete

    if (!this.macroCache.has(macroName)) {
      throw new Error(`Macro ${macroName} not found`);
    }

    const macro = this.macroCache.get(macroName);

    await this.mutex.acquire();
    try {
      const rotationState = this.macroRotationState.get(macroName);

      if (!macro.content || macro.content.length === 0) {
        throw new Error(`Macro ${macroName} has no content`);
      }

      const item = macro.content[rotationState.index];
      rotationState.index = (rotationState.index + 1) % macro.content.length;
      this.macroRotationState.set(macroName, rotationState);

      return item;
    } finally {
      this.mutex.release();
    }
  }

  getRandomMacroItem(macroName) {
    if (!this.macroCache.has(macroName)) {
      throw new Error(`Macro ${macroName} not found`);
    }

    const macro = this.macroCache.get(macroName);

    if (!macro.content || macro.content.length === 0) {
      throw new Error(`Macro ${macroName} has no content`);
    }

    return macro.content[Math.floor(Math.random() * macro.content.length)];
  }

  processSpintax(text) {
    if (!text || typeof text !== "string") {
      return text;
    }

    let processedText = text;
    let spintaxCount = 0;
    let maxIterations = 10;
    let iteration = 0;

    const spintaxPattern = /\{([^{}]*(?:\|[^{}]*)+)\}/g;

    while (spintaxPattern.test(processedText) && iteration < maxIterations) {
      iteration++;
      spintaxPattern.lastIndex = 0;

      processedText = processedText.replace(
        spintaxPattern,
        (match, content) => {
          try {
            const options = content
              .split("|")
              .map((option) => option.trim())
              .filter((option) => option.length > 0);

            if (options.length === 0) {
              return match;
            }

            spintaxCount++;
            return options[Math.floor(Math.random() * options.length)];
          } catch (error) {
            console.error(
              `❌ Error processing spintax ${match}: ${error.message}`,
            );
            return match;
          }
        },
      );
    }

    if (spintaxCount > 0) {
      this.usageStats.spintaxProcessed += spintaxCount;
    }

    return processedText;
  }

  processMailMergeTags(text, recipientData = {}) {
    if (!text || typeof text !== "string") {
      return text;
    }

    let processedText = text;
    let mailMergeCount = 0;

    const tagProcessors = {
      "{{email}}": () => recipientData.email || "user@example.com",
      "{{firstName}}": () =>
        recipientData.firstName || recipientData.name || "Friend",
      "{{lastName}}": () => recipientData.lastName || "",
      "{{fullName}}": () => {
        if (recipientData.fullName) return recipientData.fullName;
        const first = recipientData.firstName || recipientData.name || "Friend";
        const last = recipientData.lastName || "";
        return `${first} ${last}`.trim();
      },
      "{{name}}": () =>
        recipientData.name || recipientData.firstName || "Friend",

      "{{domain}}": () => {
        if (recipientData.email) {
          return recipientData.email.split("@")[1] || "example.com";
        }
        return "example.com";
      },
      "{{user}}": () => {
        if (recipientData.email) {
          return recipientData.email.split("@")[0] || "user";
        }
        return recipientData.firstName || "user";
      },

      "{{randomIP}}": () => this.generateRandomIP(),
      "{{randomPhone}}": () => this.generateRandomPhone(),
      "{{randomDate}}": () => this.generateRandomDate(),
      "{{randomTime}}": () => this.generateRandomTime(),
      "{{randomNumber}}": () => this.generateRandomNumber(),
      "{{randomString}}": () => this.generateRandomString(),

      "{{currentDate}}": () => new Date().toLocaleDateString("en-US"),
      "{{currentTime}}": () => new Date().toLocaleTimeString("en-US"),
      "{{currentDateTime}}": () => new Date().toLocaleString("en-US"),
      "{{timestamp}}": () => Date.now().toString(),

      "{{randomId}}": () => crypto.randomBytes(8).toString("hex"),
      "{{uuid}}": () => crypto.randomUUID(),
    };

    Object.entries(tagProcessors).forEach(([tag, processor]) => {
      const regex = new RegExp(tag.replace(/[{}]/g, "\\$&"), "gi");

      if (regex.test(processedText)) {
        try {
          const replacement = processor();
          processedText = processedText.replace(regex, replacement);
          mailMergeCount++;
        } catch (error) {
          console.error(
            `❌ Error processing mail merge tag ${tag}: ${error.message}`,
          );
        }
      }
    });

    if (mailMergeCount > 0) {
      this.usageStats.mailMergeProcessed += mailMergeCount;
    }

    return processedText;
  }

  generateRandomPhone() {
    const areaCode = Math.floor(Math.random() * 800) + 200;
    const exchange = Math.floor(Math.random() * 800) + 200;
    const number = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, "0");
    return `(${areaCode}) ${exchange}-${number}`;
  }

  generateRandomDate(daysFromNow = 30) {
    const now = new Date();
    const randomDays =
      Math.floor(Math.random() * daysFromNow) - daysFromNow / 2;
    const randomDate = new Date(
      now.getTime() + randomDays * 24 * 60 * 60 * 1000,
    );
    return randomDate.toLocaleDateString("en-US");
  }

  generateRandomTime() {
    const hours = Math.floor(Math.random() * 12) + 1;
    const minutes = Math.floor(Math.random() * 60);
    const ampm = Math.random() < 0.5 ? "AM" : "PM";
    return `${hours}:${minutes.toString().padStart(2, "0")} ${ampm}`;
  }

  generateRandomNumber(min = 1, max = 100) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  generateRandomString(length = 8) {
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from({ length }, () =>
      chars.charAt(Math.floor(Math.random() * chars.length)),
    ).join("");
  }

  generateRandomIP() {
    return Array.from({ length: 4 }, () =>
      Math.floor(Math.random() * 256),
    ).join(".");
  }

  async processMacroTags(text, useSequential = true) {
    if (!text || typeof text !== "string") {
      return text;
    }

    let processedText = text;
    let macroCount = 0;

    const macroPattern = /{{(MACRO\d+)}}/gi;
    const matches = [...text.matchAll(macroPattern)];

    for (const match of matches) {
      try {
        const macroName = match[1].toUpperCase();

        if (!this.macroCache.has(macroName)) {
          console.warn(`⚠️ Macro ${macroName} not found`);
          continue;
        }

        const replacement = useSequential
          ? await this.getNextMacroItem(macroName)
          : this.getRandomMacroItem(macroName);

        processedText = processedText.replace(match[0], replacement);
        macroCount++;
      } catch (error) {
        console.error(
          `❌ Error processing macro ${match[0]}: ${error.message}`,
        );
      }
    }

    if (macroCount > 0) {
      this.usageStats.macrosProcessed += macroCount;
    }

    return processedText;
  }

  async processContent(text, recipientData = {}, options = {}) {
    if (!text || typeof text !== "string") {
      return String(text || "");
    }

    const {
      enableMacros = true,
      enableMailMerge = true,
      enableSpintax = true,
      useSequentialMacros = true,
    } = options;

    let processedText = String(text);

    try {
      if (enableMacros) {
        const macroResult = await this.processMacroTags(
          processedText,
          useSequentialMacros,
        );
        processedText = String(macroResult || processedText);
      }

      if (enableMailMerge) {
        const mailMergeResult = this.processMailMergeTags(
          processedText,
          recipientData,
        );
        processedText = String(mailMergeResult || processedText);
      }

      if (enableSpintax) {
        const spintaxResult = this.processSpintax(processedText);
        processedText = String(spintaxResult || processedText);
      }

      this.usageStats.totalProcessed++;
    } catch (error) {
      console.error(`❌ Error processing content: ${error.message}`);
      return String(text);
    }

    return String(processedText);
  }

  getAvailableMacros() {
    return Array.from(this.macroFiles.entries()).map(([name, filePath]) => ({
      name,
      filePath,
      itemCount: this.macroCache.get(name)?.totalItems || 0,
      currentIndex: this.macroRotationState.get(name)?.index || 0,
    }));
  }

  async createExampleMacros() {
    const examples = {
      "MACRO1.txt": [
        "amazing",
        "fantastic",
        "incredible",
        "outstanding",
        "excellent",
        "remarkable",
        "wonderful",
        "brilliant",
        "superb",
        "magnificent",
      ],
      "MACRO2.txt": [
        "offer",
        "deal",
        "opportunity",
        "promotion",
        "special",
        "discount",
        "savings",
        "bonus",
        "advantage",
      ],
      "MACRO3.txt": [
        "today",
        "right now",
        "immediately",
        "this week",
        "soon",
        "quickly",
        "without delay",
        "at once",
        "promptly",
        "instantly",
      ],
    };

    for (const [filename, content] of Object.entries(examples)) {
      const filePath = path.join(this.macroDirectory, filename);

      try {
        await fs.promises.access(filePath);
      } catch {
        try {
          await fs.promises.writeFile(filePath, content.join("\n"), "utf-8");
          console.log(`📝 Created example macro: ${filename}`);
        } catch (error) {
          console.error(`Failed to create macro ${filename}: ${error.message}`);
        }
      }
    }

    await this.loadMacroFiles();
  }

  async cleanup() {
    // Clear all caches and references
    this.macroCache.clear();
    this.macroFiles.clear();
    this.macroRotationState.clear();

    // Clear usage stats to prevent memory leaks
    this.usageStats = {
      macrosProcessed: 0,
      spintaxProcessed: 0,
      mailMergeProcessed: 0,
      totalProcessed: 0,
    };

    console.log("✅ Dynamic Content Processor cleaned up");
  }
}

// ===== SMTP MANAGER CLASS (FIXED) =====
class SMTPManager {
  constructor(smtpConfig = {}, proxyList = [], options = {}) {
    this.smtpConfigs = this.loadSmtpConfigs();

    if (this.smtpConfigs.length === 0) {
      throw new Error(
        "No SMTP configurations found. Check your .env file has SMTP_HOST_1, SMTP_FROM_1, etc.",
      );
    }

    this.proxyList = proxyList;
    this.options = {
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 1000,
      connectionTimeout: options.connectionTimeout || 30000,
      socketTimeout: options.socketTimeout || 30000,
      ...options,
    };

    // OPTIMIZATION: Check if rotation is enabled
    this.rotationEnabled = config.smtp?.rotation?.enabled || false;

    // Thread-safe rotation state with atomic counters
    this.atomicCounters = {
      emailCounter: 0,
      currentSmtpIndex: 0,
      currentProxyIndex: 0,
      currentHeaderIndex: 0,
    };

    // Initialize from address rotation managers for each SMTP
    this.fromAddressRotators = new Map();

    // Set up rotators for each SMTP that has multiple from addresses
    for (let i = 0; i < this.smtpConfigs.length; i++) {
      const fromEmailsEnv = process.env[`SMTP_FROM_${i + 1}`];
      const fromEmails =
        fromEmailsEnv && typeof fromEmailsEnv === "string"
          ? fromEmailsEnv
              .split(",")
              .map((email) => email.trim())
              .filter((email) => this.isValidEmail(email))
          : [];

      if (fromEmails.length > 1) {
        this.fromAddressRotators.set(
          i,
          new RotationManager(fromEmails, `from_smtp_${i + 1}`, {
            email: {
              from: {
                rotation: {
                  enabled: config.email?.from?.rotation?.enabled,
                  strategy: config.email?.from?.rotation?.strategy || "random",
                },
              },
            },
          }),
        );
        console.log(
          `🔄 From address rotation initialized for SMTP ${i + 1}: ${fromEmails.length} addresses, strategy: ${config.email?.from?.rotation?.strategy || "random"}`,
        );
      }
    }

    // Initialize proxy rotation manager if proxies are available
    if (this.proxyList.length > 0) {
      this.proxyRotation = new RotationManager(this.proxyList, "proxy", config);
      console.log(
        `🔄 Proxy rotation initialized: ${this.proxyList.length} proxies, strategy: ${config.proxy?.rotation?.strategy || "sequential"}, enabled: ${config.proxy?.rotation?.enabled || false}`,
      );
    } else {
      this.proxyRotation = null;
    }

    // Thread safety
    this.rotationMutex = new AsyncMutex();
    this.rateLimitMutex = new AsyncMutex();

    // ✅ FIXED: Independent controls without performance.enabled fallback
    this.poolingEnabled =
      config.smtp.performance?.connectionPooling?.enabled || false;
    this.warmupEnabled = config.smtp.warmup?.enabled || false;

    // Store warmup config for easy access
    this.warmupConfig = {
      connections: config.smtp.warmup?.connections || this.smtpConfigs.length,
      timeout: config.smtp.warmup?.timeout || 5000,
      verifyConnections: config.smtp.warmup?.verifyConnections !== false,
    };

    // ✅ CRITICAL FIX: Initialize connectionStats to prevent undefined errors
    this.connectionStats = {
      warmupTime: 0,
      connectionsCreated: 0,
      connectionsReused: 0,
      verificationsFailed: 0,
    };

    console.log(
      `🔧 SMTP warmup: ${this.warmupEnabled ? "ENABLED" : "DISABLED"}`,
    );
    console.log(
      `🔧 SMTP connection pooling: ${this.poolingEnabled ? "ENABLED" : "DISABLED"}`,
    );

    // Transport pool (only if pooling is enabled)
    if (this.poolingEnabled) {
      this.transportPool = new LRUCache(50);
      console.log("🔧 SMTP connection pooling enabled");
    } else {
      this.transportPool = null;
      console.log("🚫 SMTP connection pooling disabled");
    }

    // OPTIMIZATION: Only initialize rotation structures when rotation is enabled
    if (this.rotationEnabled) {
      // Full rotation mode - initialize for all SMTP configs
      this.emailsSentPerSmtp = new Array(this.smtpConfigs.length).fill(0);
      this.lastUsedSmtpIndex = -1;

      this.smtpHealth = new Array(this.smtpConfigs.length).fill().map(() => ({
        consecutive_failures: 0,
        last_success: null,
        last_failure: null,
        is_healthy: true,
        response_times: [],
      }));

      // Fixed: Simplified rate limiting
      this.perSmtpRateLimiting = new Array(this.smtpConfigs.length)
        .fill()
        .map((_, index) => ({
          smtpIndex: index,
          emailsSentInCurrentMinute: 0,
          currentMinuteStart: Date.now(),
          isLimited: false,
          isCoolingDown: false,
          cooldownStartTime: null,
          cooldownDuration:
            (config.smtp.rateLimit?.cooldownPeriod || 60) * 1000,
          emailsPerMinute: config.smtp.rateLimit?.emailsPerMinute || 30,
          lastEmailTime: 0,
          consecutiveLimitHits: 0,
        }));

      // Simplified coordination
      this.availableSmtps = [...Array(this.smtpConfigs.length).keys()];
      this.cooldownTimers = new Map();

      // Health check tracking
      this.lastHealthCheckPerSmtp = new Array(this.smtpConfigs.length).fill(0);
      this.healthCheckEmailCountPerSmtp = new Array(
        this.smtpConfigs.length,
      ).fill(0);
      this.healthCheckInProgress = new Array(this.smtpConfigs.length).fill(
        false,
      );
      this.healthCheckTimeout = 2000;
      this.healthCheckInterval = 500;
      this.warmedUp = false;

      this._initializeCoordination();
    } else {
      // Single SMTP mode - minimal initialization
      this.emailsSentPerSmtp = [0]; // Only track first SMTP
      this.lastUsedSmtpIndex = 0; // Always use first SMTP

      // Single SMTP health tracking
      this.smtpHealth = [
        {
          consecutive_failures: 0,
          last_success: null,
          last_failure: null,
          is_healthy: true,
          response_times: [],
        },
      ];

      // Single SMTP rate limiting
      this.perSmtpRateLimiting = [
        {
          smtpIndex: 0,
          emailsSentInCurrentMinute: 0,
          currentMinuteStart: Date.now(),
          isLimited: false,
          isCoolingDown: false,
          cooldownStartTime: null,
          cooldownDuration:
            (config.smtp.rateLimit?.cooldownPeriod || 60) * 1000,
          emailsPerMinute: config.smtp.rateLimit?.emailsPerMinute || 30,
          lastEmailTime: 0,
          consecutiveLimitHits: 0,
        },
      ];

      // Single SMTP coordination
      this.availableSmtps = [0]; // Only first SMTP available
      this.cooldownTimers = new Map();

      // Single SMTP health check tracking
      this.lastHealthCheckPerSmtp = [0];
      this.healthCheckEmailCountPerSmtp = [0];
      this.healthCheckInProgress = [false];
      this.healthCheckTimeout = 2000;
      this.healthCheckInterval = 500;
      this.warmedUp = false; // Initialize minimal coordination
      this._initializeCoordination();
    }

    // Initialize periodic pool cleanup
    this._startPeriodicPoolCleanup();
  }

  // Thread-safe atomic operations
  getNextEmailNumber() {
    // Use atomic-like operation
    const current = this.atomicCounters.emailCounter;
    this.atomicCounters.emailCounter = current + 1;
    return current + 1;
  }

  async getNextSmtpIndex() {
    await this.rotationMutex.acquire();
    try {
      const availableSmtps = this.getAvailableSMTPs();

      // ✅ FIXED: Better error handling for no available SMTPs
      if (!availableSmtps || availableSmtps.length === 0) {
        throw new Error(
          "No available SMTP servers - check SMTP health and rate limits",
        );
      }

      let selectedIndex;
      const strategy = config.smtp?.rotation?.strategy || "sequential";

      if (strategy === "random") {
        // ✅ FIXED: Extra bounds checking for random selection
        const randomIndex = Math.floor(Math.random() * availableSmtps.length);
        const selectedSmtp = availableSmtps[randomIndex];
        if (!selectedSmtp || typeof selectedSmtp.index !== "number") {
          selectedIndex = availableSmtps[0].index;
        } else {
          selectedIndex = selectedSmtp.index;
        }
      } else {
        // ✅ FIXED: Sequential strategy with proper bounds checking
        const currentIndex = this.atomicCounters.currentSmtpIndex || 0;
        const normalizedIndex = currentIndex % availableSmtps.length;
        const selectedSmtp = availableSmtps[normalizedIndex];

        if (!selectedSmtp || typeof selectedSmtp.index !== "number") {
          // Fallback to first SMTP
          selectedIndex = availableSmtps[0].index;
          this.atomicCounters.currentSmtpIndex = 1;
        } else {
          selectedIndex = selectedSmtp.index;
          this.atomicCounters.currentSmtpIndex =
            (currentIndex + 1) % availableSmtps.length;
        }
      }

      // ✅ FIXED: Validate selectedIndex before returning
      const isValidIndex = availableSmtps.some(
        (smtp) => smtp && smtp.index === selectedIndex,
      );
      if (!isValidIndex) {
        // Final safety check - ensure we have a valid SMTP
        if (availableSmtps.length === 0) {
          throw new Error("No valid SMTP servers available");
        }
        console.warn(
          `Invalid SMTP index ${selectedIndex}, using first available`,
        );
        selectedIndex = availableSmtps[0].index;
      }

      return selectedIndex;
    } finally {
      this.rotationMutex.release();
    }
  }

  incrementSmtpEmailCount(smtpIndex) {
    this.emailsSentPerSmtp[smtpIndex]++;
    this.healthCheckEmailCountPerSmtp[smtpIndex]++;
  }

  loadSmtpConfigs() {
    const configs = [];
    let index = 1;

    while (process.env[`SMTP_HOST_${index}`]) {
      const config = {
        id: `smtp_${index}`,
        host: process.env[`SMTP_HOST_${index}`],
        port: parseInt(process.env[`SMTP_PORT_${index}`]) || 587,
        secure: process.env[`SMTP_SECURE_${index}`] === "true",
        fromEmail: process.env[`SMTP_FROM_${index}`],
        priority: parseInt(process.env[`SMTP_PRIORITY_${index}`]) || 1,
      };

      if (
        process.env[`SMTP_USER_${index}`] &&
        process.env[`SMTP_PASS_${index}`]
      ) {
        config.auth = {
          user: process.env[`SMTP_USER_${index}`],
          pass: process.env[`SMTP_PASS_${index}`],
        };
      }

      if (!config.host || !config.fromEmail) {
        console.warn(
          `SMTP config ${index} is missing required fields, skipping`,
        );
        index++;
        continue;
      }

      // Validate email format
      if (!this.isValidEmail(config.fromEmail)) {
        console.warn(`SMTP config ${index} has invalid fromEmail, skipping`);
        index++;
        continue;
      }

      configs.push(config);
      index++;
    }

    if (configs.length === 0) {
      throw new Error(
        "No valid SMTP configurations found in environment variables",
      );
    }

    // Validate all configurations are properly formed
    this.validateConfigurations(configs);

    console.log(`✅ Loaded ${configs.length} SMTP configurations`);
    return configs;
  }

  validateConfigurations(configs) {
    for (const config of configs) {
      if (!config.host || !config.fromEmail) {
        throw new Error(`Invalid SMTP config: ${JSON.stringify(config)}`);
      }
      if (!this.isValidEmail(config.fromEmail)) {
        throw new Error(
          `Invalid fromEmail in SMTP config: ${config.fromEmail}`,
        );
      }
    }
  }

  // REMOVED: Duplicate sender name manager to prevent rotation conflicts
  // Sender name rotation is handled globally via getSenderNameRotation()

  _initializeCoordination() {
    if (this.rotationEnabled) {
      console.log(
        `🔄 Initializing SMTP rotation for ${this.smtpConfigs.length} servers...`,
      );
    } else {
      console.log(
        `🎯 Optimized single SMTP mode (rotation disabled) - using first server only`,
      );
    }

    if (config.smtp.rateLimit?.enabled) {
      this.perSmtpRateLimiting.forEach((rateLimit, index) => {
        rateLimit.cooldownDuration =
          (config.smtp.rateLimit.cooldownPeriod || 60) * 1000;
        setInterval(() => {
          this._resetRateLimitCounter(index);
        }, 60000);
      });

      console.log(`✅ SMTP coordination initialized`);
      console.log(
        `📊 Rate limit: ${this.perSmtpRateLimiting[0].emailsPerMinute} emails/minute per SMTP`,
      );
      console.log(
        `⏱️ Cooldown period: ${this.perSmtpRateLimiting[0].cooldownDuration / 1000}s`,
      );
    } else {
      if (this.rotationEnabled) {
        console.log(`✅ SMTP rotation initialized (rate limiting disabled)`);
      } else {
        console.log(`✅ Single SMTP mode initialized (rate limiting disabled)`);
      }
    }
  }

  async getNextSMTP() {
    // OPTIMIZATION: Use rotation enabled flag from constructor
    if (!this.rotationEnabled || this.smtpConfigs.length === 1) {
      return await this._buildSmtpObject(0);
    }

    const smtpIndex = await this.getNextSmtpIndex();
    return await this._buildSmtpObject(smtpIndex);
  }

  getAvailableSMTPs() {
    // OPTIMIZATION: For single SMTP mode, only check first SMTP
    const smtpIndices = this.rotationEnabled
      ? Array.from({ length: this.smtpConfigs.length }, (_, i) => i)
      : [0]; // Only first SMTP when rotation disabled

    const allSmtps = smtpIndices.map((index) => ({
      config: this.smtpConfigs[index],
      index,
      health: this.smtpHealth[index],
      rateLimit: this.perSmtpRateLimiting[index],
    }));

    const availableSmtps = allSmtps.filter(({ health, rateLimit }) => {
      if (!config.smtp.rateLimit?.enabled) {
        return health.is_healthy;
      }
      return (
        health.is_healthy && !rateLimit.isCoolingDown && !rateLimit.isLimited
      );
    });

    if (availableSmtps.length === 0) {
      const healthySmtps = allSmtps.filter(({ health }) => health.is_healthy);
      if (healthySmtps.length > 0) {
        return healthySmtps;
      }
    }

    return availableSmtps.sort((a, b) => {
      if (a.config.priority !== b.config.priority) {
        return b.config.priority - a.config.priority;
      }
      return a.health.consecutive_failures - b.health.consecutive_failures;
    });
  }

  async _buildSmtpObject(smtpIndex) {
    const smtpConfig = this.smtpConfigs[smtpIndex];
    const smtp = {
      ...smtpConfig,
      selectedIndex: smtpIndex,
      serverIndex: smtpIndex,
      serverInfo: {
        index: smtpIndex,
        totalSent: this.emailsSentPerSmtp[smtpIndex] || 0,
        totalServers: this.smtpConfigs.length,
        health: this.smtpHealth[smtpIndex],
        rateLimit: this.perSmtpRateLimiting[smtpIndex],
      },
    };

    await this.enrichSMTPConfig(smtp, smtpIndex);
    return smtp;
  }

  markSmtpHealthy(smtpIndex, responseTime = null) {
    const health = this.smtpHealth[smtpIndex];
    health.consecutive_failures = 0;
    health.last_success = new Date();
    health.is_healthy = true;

    if (responseTime) {
      health.response_times.push(responseTime);
      if (health.response_times.length > 10) {
        health.response_times.shift();
      }
    }
  }

  markSmtpUnhealthy(smtpIndex, error = null) {
    const health = this.smtpHealth[smtpIndex];
    health.consecutive_failures++;
    health.last_failure = new Date();

    if (health.consecutive_failures >= 3) {
      health.is_healthy = false;
      console.warn(
        `⚠️ SMTP ${smtpIndex + 1} marked as unhealthy after ${health.consecutive_failures} failures`,
      );
    }
  }

  async getSenderName() {
    // Sender name rotation handled globally - this method deprecated
    return "";
  }

  async enrichSMTPConfig(smtp, smtpIndex) {
    const userEnv = process.env[`SMTP_USER_${smtpIndex + 1}`];
    const passEnv = process.env[`SMTP_PASS_${smtpIndex + 1}`];

    if (userEnv && passEnv) {
      smtp.auth = { user: userEnv, pass: passEnv };
    }

    // Enhanced from address rotation using RotationManager
    if (
      config.email?.from?.rotation?.enabled &&
      this.fromAddressRotators.has(smtpIndex)
    ) {
      try {
        smtp.fromEmail = await this.fromAddressRotators
          .get(smtpIndex)
          .getNext();

        // Debug logging for from address rotation
        if (config.debug?.showRotation) {
          const strategy = config.email?.from?.rotation?.strategy || "random";
          console.log(
            `🔄 From address rotation (SMTP ${smtpIndex + 1}): strategy=${strategy}, selected="${smtp.fromEmail}"`,
          );
        }
      } catch (error) {
        console.warn(
          `⚠️ From address rotation failed for SMTP ${smtpIndex + 1}: ${error.message}`,
        );
        // Fall back to first address
        const fromEmailsEnv = process.env[`SMTP_FROM_${smtpIndex + 1}`];
        const fromEmails =
          fromEmailsEnv && typeof fromEmailsEnv === "string"
            ? fromEmailsEnv
                .split(",")
                .map((email) => email.trim())
                .filter((email) => this.isValidEmail(email))
            : [];

        smtp.fromEmail =
          fromEmails[0] || process.env[`SMTP_FROM_${smtpIndex + 1}`];
      }
    } else {
      // No rotation or single address - use first address or env variable
      const fromEmailsEnv = process.env[`SMTP_FROM_${smtpIndex + 1}`];
      const fromEmails =
        fromEmailsEnv && typeof fromEmailsEnv === "string"
          ? fromEmailsEnv
              .split(",")
              .map((email) => email.trim())
              .filter((email) => this.isValidEmail(email))
          : [];

      smtp.fromEmail =
        fromEmails[0] || process.env[`SMTP_FROM_${smtpIndex + 1}`];
    }
  }

  // Fixed: Simplified rate limiting without deadlocks
  async checkSmtpRateLimit(smtpIndex) {
    if (!config.smtp.rateLimit?.enabled) {
      return { allowed: true, waitTime: 0 };
    }

    await this.rateLimitMutex.acquire();
    try {
      const rateLimit = this.perSmtpRateLimiting[smtpIndex];
      const now = Date.now();

      // Check cooldown
      if (rateLimit.isCoolingDown) {
        const cooldownTimeLeft =
          rateLimit.cooldownStartTime + rateLimit.cooldownDuration - now;

        if (cooldownTimeLeft <= 0) {
          this._removeSMTPFromCooldown(smtpIndex);
          return { allowed: true, waitTime: 0 };
        }

        return {
          allowed: false,
          waitTime: cooldownTimeLeft,
          reason: "cooldown",
        };
      }

      // Reset counter if minute passed
      const timeElapsed = now - rateLimit.currentMinuteStart;
      if (timeElapsed >= 60000) {
        this._resetRateLimitCounter(smtpIndex);
      }

      // Check rate limit
      if (rateLimit.emailsSentInCurrentMinute >= rateLimit.emailsPerMinute) {
        this._putSMTPIntoCooldown(smtpIndex);
        return {
          allowed: false,
          waitTime: rateLimit.cooldownDuration,
          reason: "rate_limit_exceeded",
        };
      }

      return { allowed: true, waitTime: 0 };
    } finally {
      this.rateLimitMutex.release();
    }
  }

  async incrementSmtpRateLimit(smtpIndex) {
    if (!config.smtp.rateLimit?.enabled) return;

    await this.rateLimitMutex.acquire();
    try {
      const rateLimit = this.perSmtpRateLimiting[smtpIndex];

      // ✅ FIXED: Proper initialization and atomic increment
      const currentCount = Number(rateLimit.emailsSentInCurrentMinute) || 0;
      rateLimit.emailsSentInCurrentMinute = Math.min(
        currentCount + 1,
        rateLimit.emailsPerMinute || 30,
      );

      rateLimit.lastEmailTime = Date.now();
    } finally {
      this.rateLimitMutex.release();
    }
  }

  _resetRateLimitCounter(smtpIndex) {
    const rateLimit = this.perSmtpRateLimiting[smtpIndex];
    rateLimit.emailsSentInCurrentMinute = 0;
    rateLimit.currentMinuteStart = Date.now();
    rateLimit.isLimited = false;
  }

  _putSMTPIntoCooldown(smtpIndex) {
    const rateLimit = this.perSmtpRateLimiting[smtpIndex];

    rateLimit.isCoolingDown = true;
    rateLimit.cooldownStartTime = Date.now();

    console.log(`🔄 SMTP ${smtpIndex + 1} cooling down...`);

    const timerId = setTimeout(() => {
      this._removeSMTPFromCooldown(smtpIndex);
    }, rateLimit.cooldownDuration);

    this.cooldownTimers.set(smtpIndex, timerId);
  }

  _removeSMTPFromCooldown(smtpIndex) {
    const rateLimit = this.perSmtpRateLimiting[smtpIndex];

    rateLimit.isCoolingDown = false;
    rateLimit.cooldownStartTime = null;
    rateLimit.isLimited = false;

    if (this.cooldownTimers.has(smtpIndex)) {
      clearTimeout(this.cooldownTimers.get(smtpIndex));
      this.cooldownTimers.delete(smtpIndex);
    }

    this._resetRateLimitCounter(smtpIndex);
    console.log(`✅ SMTP ${smtpIndex + 1} ready`);
  }

  markSmtpAsUsed(smtpIndex) {
    this.incrementSmtpEmailCount(smtpIndex);
    this.markSmtpHealthy(smtpIndex);
    this.lastUsedSmtpIndex = smtpIndex;
  }

  async getNextProxy() {
    if (!this.proxyList.length) return null;

    // FIXED: Check if rotation is disabled - always use first proxy
    if (!config.proxy?.rotation?.enabled) {
      console.log(`🎯 Proxy rotation disabled: using first proxy only`);
      return this.proxyList[0];
    }

    // ENHANCED: Use RotationManager for consistent behavior with other components
    if (this.proxyRotation) {
      try {
        const proxy = await this.proxyRotation.getNext();

        // Debug logging for proxy rotation
        if (config.debug?.showRotation) {
          const strategy = config.proxy?.rotation?.strategy || "sequential";
          console.log(
            `🔄 Proxy rotation: strategy=${strategy}, selected="${proxy.host}:${proxy.port}"`,
          );
        }

        return proxy;
      } catch (error) {
        console.warn(`⚠️ Proxy rotation failed: ${error.message}`);
        // Fall back to first proxy
        return this.proxyList[0];
      }
    }

    // FALLBACK: Direct implementation if RotationManager not available
    const strategy = config.proxy?.rotation?.strategy || "sequential";

    if (strategy === "random") {
      // Random proxy selection
      const randomIndex = Math.floor(Math.random() * this.proxyList.length);
      const proxy = this.proxyList[randomIndex];

      if (config.debug?.showRotation) {
        console.log(
          `🔄 Proxy rotation (fallback): strategy=random, selected="${proxy.host}:${proxy.port}"`,
        );
      }

      return proxy;
    } else {
      // Sequential rotation (default)
      const proxy = this.proxyList[this.atomicCounters.currentProxyIndex];
      this.atomicCounters.currentProxyIndex =
        (this.atomicCounters.currentProxyIndex + 1) % this.proxyList.length;

      if (config.debug?.showRotation) {
        console.log(
          `🔄 Proxy rotation (fallback): strategy=sequential, selected="${proxy.host}:${proxy.port}"`,
        );
      }

      return proxy;
    }
  }

  async warmupSMTPConnections() {
    if (this.warmedUp) {
      console.log("🔄 SMTP connections already warmed up");
      return;
    }

    if (!this.warmupEnabled) {
      console.log("🚫 SMTP warmup disabled, skipping");
      return;
    }

    console.log("🔥 Warming up SMTP connections...");
    const startTime = Date.now();

    // Respect warmupConnections config or default to all
    const warmupCount =
      config.smtp.performance?.warmupConnections || this.smtpConfigs.length;
    const serversToWarmup = this.smtpConfigs.slice(0, warmupCount);

    console.log(
      `🎯 Warming up ${serversToWarmup.length} of ${this.smtpConfigs.length} servers`,
    );

    const warmupPromises = serversToWarmup.map(async (smtpConfig, index) => {
      try {
        const smtp = await this._buildSmtpObject(index);
        const transport = await this.createTransport(smtp);

        // Verify connection with timeout
        const verifyPromise = transport.verify();
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Verification timeout")), 5000),
        );

        await Promise.race([verifyPromise, timeoutPromise]);

        // ✅ FIX 3: Always close warmup connections and remove from pool
        if (transport && typeof transport.close === "function") {
          transport.close();
        }

        // Remove from pool since warmup connections shouldn't be reused
        if (this.poolingEnabled && this.transportPool) {
          const transportKey = `${smtp.id}_direct`;
          this.transportPool.delete(transportKey);
        }

        console.log(`✅ SMTP ${index + 1} (${smtp.host}) warmed up`);
        return { index, success: true, host: smtp.host };
      } catch (error) {
        this.connectionStats.verificationsFailed++;
        console.warn(`⚠️ SMTP ${index + 1} warmup failed: ${error.message}`);
        return { index, success: false, error: error.message };
      }
    });

    const results = await Promise.all(warmupPromises);
    const successful = results.filter((r) => r.success).length;

    this.connectionStats.warmupTime = Date.now() - startTime;
    this.warmedUp = true;

    console.log(
      `🚀 SMTP warmup completed: ${successful}/${warmupCount} servers ready (${this.connectionStats.warmupTime}ms)`,
    );

    return results;
  }

  getConnectionStats() {
    return {
      warmedUp: this.warmedUp,
      warmupTime: `${this.connectionStats.warmupTime}ms`,
      connectionsCreated: this.connectionStats.connectionsCreated,
      connectionsReused: this.connectionStats.connectionsReused,
      verificationsFailed: this.connectionStats.verificationsFailed,
      poolSize:
        this.poolingEnabled && this.transportPool ? this.transportPool.size : 0,
      poolingEnabled: this.poolingEnabled, // ✅ Show pooling status
      warmupEnabled: this.warmupEnabled, // ✅ Show warmup status
      warmupConfig: this.warmupConfig, // ✅ Show warmup settings
      reuseRate:
        this.connectionStats.connectionsCreated > 0
          ? `${((this.connectionStats.connectionsReused / this.connectionStats.connectionsCreated) * 100).toFixed(1)}%`
          : "0%",
    };
  }

  async createTransport(smtp, proxy = null) {
    const transportKey = `${smtp.id}_${proxy?.host || "direct"}`;

    // Only use pooling if explicitly enabled
    if (this.poolingEnabled && this.transportPool) {
      let mutexAcquired = false;
      let pooledTransport = null;

      try {
        await this.rateLimitMutex.acquire();
        mutexAcquired = true;

        // Check if transport exists in pool
        if (this.transportPool.has(transportKey)) {
          const transport = this.transportPool.get(transportKey);

          // FIXED: Check transport without returning inside try block
          try {
            if (transport && !transport.destroyed) {
              this.connectionStats.connectionsReused++;
              console.log(`🔄 Reusing SMTP connection for ${smtp.host}`);

              // Move to end (LRU behavior)
              this.transportPool.delete(transportKey);
              this.transportPool.set(transportKey, transport);
              pooledTransport = transport; // Store for return after mutex release
            } else {
              // Only remove truly destroyed transports
              console.log(
                `❌ Transport destroyed, removing from pool for ${smtp.host}`,
              );
              this.transportPool.delete(transportKey);
            }
          } catch (error) {
            console.warn(
              `⚠️ Transport health check failed for ${smtp.host}: ${error.message}`,
            );
            // Remove unhealthy transport and create new one
            this.transportPool.delete(transportKey);
          }
        }
      } catch (mutexError) {
        console.error(`❌ Mutex acquisition failed: ${mutexError.message}`);
        // Continue without pooling if mutex fails
      } finally {
        if (mutexAcquired) {
          try {
            this.rateLimitMutex.release();
          } catch (releaseError) {
            console.error(`❌ Mutex release failed: ${releaseError.message}`);
          }
        }
      }

      // Return pooled transport if found (after mutex is released)
      if (pooledTransport) {
        return pooledTransport;
      }
    }

    // Create new transport
    let agent;
    if (proxy) {
      try {
        if (proxy.type === "socks5") {
          agent = new SocksProxyAgent(`socks5://${proxy.host}:${proxy.port}`);
        } else if (proxy.type === "http") {
          agent = new HttpsProxyAgent(`http://${proxy.host}:${proxy.port}`);
        }
      } catch (error) {
        console.warn(`Failed to create proxy agent: ${error.message}`);
      }
    }

    const connectionTimeout =
      config.smtp.performance?.connectionTimeout ||
      this.options.connectionTimeout;
    const socketTimeout =
      config.smtp.performance?.socketTimeout || this.options.socketTimeout;

    const transportConfig = {
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      from: smtp.fromEmail,
      connectionTimeout: connectionTimeout,
      socketTimeout: socketTimeout,
      ...(smtp.auth && { auth: smtp.auth }),
      ...(agent && { agent }),
      tls: {
        rejectUnauthorized: false,
        ciphers: "SSLv3",
      },
      // ✅ FIX: Proper pooling settings - all from config.js
      pool: this.poolingEnabled,
      maxConnections: this.poolingEnabled
        ? config.smtp.rateLimit?.transport?.maxConnections || 15
        : 1,
      maxMessages: this.poolingEnabled
        ? config.smtp.rateLimit?.transport?.maxMessages || 200
        : 1,
      keepAlive: this.poolingEnabled,
      idleTimeout: this.poolingEnabled
        ? config.smtp.performance?.connectionPooling?.idleTimeout || 30000
        : 0,
    };

    const transport = nodemailer.createTransport(transportConfig);

    // Only set up pooling logic if pooling is enabled
    if (this.poolingEnabled && this.transportPool) {
      // ✅ FIXED: Better error handling with selective removal
      const errorHandler = (error) => {
        console.warn(`Transport error for ${smtp.host}: ${error.message}`);

        // ✅ FIXED: Remove transport from pool on serious errors
        const isSerious =
          error.code === "EAUTH" ||
          error.code === "ECONNREFUSED" ||
          error.code === "ENOTFOUND" ||
          error.code === "ETIMEDOUT" ||
          error.message.includes("authentication") ||
          error.message.includes("connection refused");

        if (isSerious) {
          // Remove failed transport from pool immediately
          this._removeTransportFromPool(
            transportKey,
            `Serious error: ${error.code || error.message}`,
          );
        }
      };

      // ✅ FIXED: Better idle handling
      const idleHandler = () => {
        // Mark transport as last used for cleanup purposes
        if (transport && transport._lastUsed !== undefined) {
          transport._lastUsed = Date.now();
        }
      };

      // ✅ FIXED: Connection end handler
      const endHandler = () => {
        // Remove transport when connection ends
        this._removeTransportFromPool(transportKey, "Connection ended");
      };

      transport.on("error", errorHandler);
      transport.on("idle", idleHandler);
      transport.on("end", endHandler);

      // ✅ FIXED: Mark creation time for cleanup
      transport._createdAt = Date.now();
      transport._lastUsed = Date.now();

      // Store in pool for reuse
      await this.rateLimitMutex.acquire();
      try {
        this.transportPool.set(transportKey, transport);
      } finally {
        this.rateLimitMutex.release();
      }
    }

    this.connectionStats.connectionsCreated++;
    return transport;
  }

  // ✅ FIX: Safe transport closure method
  _safeCloseTransport(transport) {
    try {
      if (transport && typeof transport.removeAllListeners === "function") {
        transport.removeAllListeners("error");
        transport.removeAllListeners("idle");
        transport.removeAllListeners("end");
      }
      // ✅ FIX: Don't force close transport - let it close naturally
      // Only close if explicitly destroyed or cleanup needed
      if (
        transport &&
        transport.destroyed &&
        typeof transport.close === "function"
      ) {
        transport.close();
      }
    } catch (error) {
      console.warn(`Error closing transport: ${error.message}`);
    }
  }

  // ✅ FIXED: Comprehensive transport removal from pool
  _removeTransportFromPool(transportKey, reason = "Unknown") {
    if (!this.poolingEnabled || !this.transportPool) return;

    // Use setImmediate to prevent blocking
    setImmediate(async () => {
      await this.rateLimitMutex.acquire();
      try {
        if (this.transportPool.has(transportKey)) {
          const transport = this.transportPool.get(transportKey);

          // FIX: Comprehensive cleanup
          if (transport) {
            // Remove all event listeners to prevent memory leaks
            if (typeof transport.removeAllListeners === "function") {
              try {
                transport.removeAllListeners();
              } catch (listenerError) {
                // Continue cleanup even if listener removal fails
              }
            }

            // Close transport if still open
            if (typeof transport.close === "function" && !transport.destroyed) {
              try {
                transport.close();
              } catch (closeError) {
                // Force close if regular close fails
                if (
                  transport.destroy &&
                  typeof transport.destroy === "function"
                ) {
                  try {
                    transport.destroy();
                  } catch (destroyError) {
                    // Last resort - mark as destroyed manually
                    transport.destroyed = true;
                  }
                }
              }
            }

            // Clear custom properties to free memory
            try {
              delete transport._createdAt;
              delete transport._lastUsed;
            } catch (deleteError) {
              // Property deletion might fail in some environments
            }
          }

          // Remove from pool
          this.transportPool.delete(transportKey);
          console.log(`🗑️ Removed transport ${transportKey}: ${reason}`);
        }
      } catch (error) {
        console.warn(`Pool cleanup error: ${error.message}`);
      } finally {
        this.rateLimitMutex.release();
      }
    });
  }

  // ✅ NEW: Periodic cleanup of old transports
  _startPeriodicPoolCleanup() {
    if (!this.poolingEnabled || !this.transportPool) return;

    // Clean up old transports every 5 minutes
    this.poolCleanupInterval = setInterval(
      async () => {
        await this._cleanupOldTransports();
      },
      5 * 60 * 1000,
    ); // 5 minutes
  }

  async _cleanupOldTransports() {
    if (!this.poolingEnabled || !this.transportPool) return;

    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes
    const maxIdle = 10 * 60 * 1000; // 10 minutes

    await this.rateLimitMutex.acquire();
    try {
      const keysToRemove = [];
      const safetyChecks = {
        nullTransports: 0,
        destroyedTransports: 0,
        oldTransports: 0,
        idleTransports: 0,
        healthCheckFailed: 0,
      };

      // FIX: More comprehensive cleanup with safety checks
      for (const [key, transport] of this.transportPool.cache.entries()) {
        // Check for null/undefined transports
        if (!transport) {
          keysToRemove.push(key);
          safetyChecks.nullTransports++;
          continue;
        }

        // Check for destroyed transports
        if (transport.destroyed === true) {
          keysToRemove.push(key);
          safetyChecks.destroyedTransports++;
          continue;
        }

        // Check age and idle time with safety defaults
        const createdAt = transport._createdAt || 0;
        const lastUsed = transport._lastUsed || 0;
        const age = now - createdAt;
        const idleTime = now - lastUsed;

        // Remove if too old or idle too long
        if (age > maxAge) {
          keysToRemove.push(key);
          safetyChecks.oldTransports++;
        } else if (idleTime > maxIdle) {
          keysToRemove.push(key);
          safetyChecks.idleTransports++;
        }

        // FIX: Additional safety check for transport health
        try {
          if (transport.readyState && transport.readyState === "ended") {
            keysToRemove.push(key);
            safetyChecks.healthCheckFailed++;
          }

          // Check for invalid connection states
          if (transport.destroyed !== false && transport.destroyed !== true) {
            // Ambiguous destroyed state - assume compromised
            keysToRemove.push(key);
            safetyChecks.healthCheckFailed++;
          }
        } catch (healthError) {
          // Transport might be in invalid state
          keysToRemove.push(key);
          safetyChecks.healthCheckFailed++;
        }
      }

      // Remove old transports with comprehensive cleanup
      for (const key of keysToRemove) {
        try {
          const transport = this.transportPool.cache.get(key);

          // FIX: Comprehensive transport shutdown
          if (transport) {
            // Remove all event listeners to prevent memory leaks
            if (typeof transport.removeAllListeners === "function") {
              try {
                transport.removeAllListeners();
              } catch (listenerError) {
                // Continue cleanup even if listener removal fails
              }
            }

            // Close connection if still open
            if (typeof transport.close === "function" && !transport.destroyed) {
              try {
                transport.close();
              } catch (closeError) {
                // Force close if regular close fails
                if (
                  transport.destroy &&
                  typeof transport.destroy === "function"
                ) {
                  try {
                    transport.destroy();
                  } catch (destroyError) {
                    // Last resort - mark as destroyed manually
                    transport.destroyed = true;
                  }
                }
              }
            }

            // Clear custom properties to free memory
            try {
              delete transport._createdAt;
              delete transport._lastUsed;
            } catch (deleteError) {
              // Property deletion might fail in some environments
            }
          }

          // Remove from pool
          this.transportPool.delete(key);
        } catch (cleanupError) {
          console.warn(
            `Transport cleanup error for ${key}: ${cleanupError.message}`,
          );
          // Still remove from pool even if cleanup failed
          try {
            this.transportPool.delete(key);
          } catch (deleteError) {
            // Pool might be corrupted - log but continue
            console.warn(
              `Failed to remove transport ${key} from pool: ${deleteError.message}`,
            );
          }
        }
      }

      if (keysToRemove.length > 0) {
        console.log(
          `🧹 Cleaned up ${keysToRemove.length} transport(s): ${safetyChecks.nullTransports} null, ${safetyChecks.destroyedTransports} destroyed, ${safetyChecks.oldTransports} old, ${safetyChecks.idleTransports} idle, ${safetyChecks.healthCheckFailed} failed health`,
        );
      }
    } finally {
      this.rateLimitMutex.release();
    }
  }

  isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  async validateEmail(email) {
    if (!this.isValidEmail(email)) {
      return {
        valid: false,
        reason: "invalid_format",
        email: email,
      };
    }

    // If MX validation is disabled, return format validation only
    if (!config.email?.validation?.validateMXRecords) {
      return {
        valid: true,
        reason: "format_valid",
        email: email,
      };
    }

    const domain = email.split("@")[1];
    try {
      const records = await dns.promises.resolveMx(domain);
      const hasValidMX = records && records.length > 0;

      return {
        valid: hasValidMX,
        reason: hasValidMX ? "mx_valid" : "mx_invalid",
        email: email,
        domain: domain,
        mxRecords: hasValidMX ? records.length : 0,
        mxDetails: hasValidMX ? records.slice(0, 3).map((r) => r.exchange) : [],
      };
    } catch (error) {
      // Handle different types of DNS errors
      let reason = "mx_lookup_failed";
      if (error.code === "ENOTFOUND") {
        reason = "domain_not_found";
      } else if (error.code === "ENODATA") {
        reason = "no_mx_records";
      }

      return {
        valid: false,
        reason: reason,
        email: email,
        domain: domain,
        error: error.message,
      };
    }
  }

  async sendMailWithRetry(mailOptions, maxRetries = null) {
    const retries = maxRetries || this.options.maxRetries;
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const result = await this.sendMail(mailOptions);
        return result;
      } catch (error) {
        lastError = error;
        console.warn(
          `📧 Send attempt ${attempt}/${retries} failed: ${error.message}`,
        );

        if (attempt < retries) {
          const delay = this.options.retryDelay * Math.pow(2, attempt - 1); // Exponential backoff
          console.log(`n�� Waiting ${delay}ms before retry...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }

  async sendMail(
    mailOptions,
    emailNumber = null,
    threadId = null,
    retryCount = 0,
  ) {
    const startTime = Date.now();
    const maxRetries = 2;

    if (!mailOptions.to || !this.isValidEmail(mailOptions.to)) {
      throw new Error(`Invalid email address: ${mailOptions.to}`);
    }

    if (!emailNumber) {
      emailNumber = this.getNextEmailNumber();
    }

    const smtp = await this.getNextSMTP();
    const selectedSmtpIndex = smtp.selectedIndex;

    // Check rate limit before proceeding with retry limits
    const rateLimitCheck = await this.checkSmtpRateLimit(selectedSmtpIndex);
    if (!rateLimitCheck.allowed) {
      if (retryCount >= 5) {
        // Prevent infinite recursion
        throw new Error(`Rate limit exceeded after ${retryCount} retries`);
      }

      if (rateLimitCheck.waitTime > 0) {
        const backoffTime = Math.min(
          rateLimitCheck.waitTime * Math.pow(2, retryCount),
          30000,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffTime));
        return await this.sendMail(
          mailOptions,
          emailNumber,
          threadId,
          retryCount + 1,
        );
      }
    }

    // Increment rate limit counter
    await this.incrementSmtpRateLimit(selectedSmtpIndex);

    // Health check
    if (
      this.healthCheckEmailCountPerSmtp[selectedSmtpIndex] > 0 &&
      this.healthCheckEmailCountPerSmtp[selectedSmtpIndex] %
        this.healthCheckInterval ===
        0
    ) {
      setImmediate(async () => {
        try {
          await this.validateSMTPConnection(smtp, selectedSmtpIndex);
        } catch (error) {
          console.error(
            `❌ Background SMTP validation failed for server ${selectedSmtpIndex + 1}: ${error.message}`,
          );
          this.markSmtpUnhealthy(selectedSmtpIndex, error);

          // Log additional context for debugging
          if (error.code) {
            console.error(`   Error code: ${error.code}`);
          }
          if (error.errno) {
            console.error(`   Error number: ${error.errno}`);
          }
        }
      });
    }

    const proxy = config.proxy?.enabled ? await this.getNextProxy() : null;

    try {
      // FIXED: Handle sender name properly - check for empty strings
      if (!mailOptions.from) {
        mailOptions.from = smtp.fromEmail;
      }

      // Apply sender name if provided and not empty in mailOptions
      if (
        mailOptions.senderName &&
        typeof mailOptions.senderName === "string" &&
        mailOptions.senderName.trim() !== ""
      ) {
        const fromEmail = smtp.fromEmail;
        // Sanitize sender name to prevent header injection
        const safeSenderName = mailOptions.senderName
          .trim()
          .replace(/["\r\n]/g, "") // Remove quotes and line breaks
          .substring(0, 100); // Limit length

        if (safeSenderName.length > 0) {
          mailOptions.from = `"${safeSenderName}" <${fromEmail}>`;
        } else {
          mailOptions.from = fromEmail; // Fallback to email only
        }
      }

      const transporter = await this.createTransport(smtp, proxy);
      const finalHeaders = this.getEmailHeaders(smtp, mailOptions.to);

      this.logEmailDetails(smtp, mailOptions, selectedSmtpIndex, emailNumber);

      const finalMailOptions = {
        ...mailOptions,
        text: mailOptions.text || this.htmlToText(mailOptions.html || ""),
        html: mailOptions.html,
        headers: {
          ...mailOptions.headers,
          ...finalHeaders,
        },
        alternative: true,
      };

      // ✅ FIX 7: The actual send operation with detailed logging
      console.log(
        `📤 Sending email ${emailNumber} to ${mailOptions.to} via SMTP ${selectedSmtpIndex + 1}...`,
      );
      const result = await transporter.sendMail(finalMailOptions);

      const responseTime = Date.now() - startTime;
      console.log(
        `✅ Email ${emailNumber} sent successfully in ${responseTime}ms`,
      );

      // ✅ FIX 7: Only mark as healthy and update stats AFTER successful send
      this.markSmtpHealthy(selectedSmtpIndex, responseTime);
      this.analyzeSMTPResponse(result, selectedSmtpIndex);

      return result;
    } catch (error) {
      // Thread-safe rollback
      if (config.smtp.rateLimit?.enabled) {
        await this.rateLimitMutex.acquire();
        try {
          const rateLimit = this.perSmtpRateLimiting[selectedSmtpIndex];
          if (rateLimit.emailsSentInCurrentMinute > 0) {
            rateLimit.emailsSentInCurrentMinute--;
          }
        } finally {
          this.rateLimitMutex.release();
        }
      }

      this.markSmtpUnhealthy(selectedSmtpIndex, error);
      console.error(
        `❌ Failed to send via SMTP ${selectedSmtpIndex + 1}: ${error.message}`,
      );

      if (error.code === "EAUTH") {
        console.error("🔐 Authentication failed. Check SMTP credentials.");
      } else if (error.code === "ECONNECTION" || error.code === "ETIMEDOUT") {
        console.error("🔌 Connection error detected.");
      }

      setImmediate(async () => {
        try {
          await this.validateSMTPConnection(smtp, selectedSmtpIndex);
        } catch (validationError) {
          console.error(
            `❌ Background SMTP validation failed for server ${selectedSmtpIndex + 1}: ${validationError.message}`,
          );
          this.markSmtpUnhealthy(selectedSmtpIndex, validationError);

          // Log additional context for debugging
          if (validationError.code) {
            console.error(`   Error code: ${validationError.code}`);
          }
          if (validationError.errno) {
            console.error(`   Error number: ${validationError.errno}`);
          }
        }
      });
      throw error;
    }
  }

  async validateSMTPConnection(smtp, smtpIndex) {
    // FIX: Use mutex to prevent concurrent health checks on same SMTP
    await this.rateLimitMutex.acquire();
    try {
      if (this.healthCheckInProgress[smtpIndex]) {
        return;
      }

      const timeSinceLastCheck =
        Date.now() - this.lastHealthCheckPerSmtp[smtpIndex];
      if (timeSinceLastCheck < 30000) {
        return;
      }

      // Set flag inside mutex to prevent race condition
      this.healthCheckInProgress[smtpIndex] = true;
    } finally {
      this.rateLimitMutex.release();
    }

    const startTime = Date.now();
    let timeoutId = null;

    try {
      const transport = await this.createTransport(smtp);

      const healthCheckPromise = new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("Health check timeout"));
        }, this.healthCheckTimeout);

        transport.verify().then(resolve).catch(reject);
      });

      await healthCheckPromise;

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      const responseTime = Date.now() - startTime;
      this.markSmtpHealthy(smtpIndex, responseTime);
      this.lastHealthCheckPerSmtp[smtpIndex] = Date.now();
      console.log(
        `✅ SMTP ${smtpIndex + 1} health check passed in ${responseTime}ms`,
      );
    } catch (error) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      this.markSmtpUnhealthy(smtpIndex, error);
      this.lastHealthCheckPerSmtp[smtpIndex] = Date.now();
      console.warn(
        `❌ SMTP ${smtpIndex + 1} health check failed: ${error.message}`,
      );
    } finally {
      // FIX: Clear flag safely inside mutex
      await this.rateLimitMutex.acquire();
      try {
        this.healthCheckInProgress[smtpIndex] = false;
      } finally {
        this.rateLimitMutex.release();
      }
    }
  }

  analyzeSMTPResponse(result, smtpIndex) {
    const { response } = result;

    if (!response) {
      console.warn(`⚠️ No SMTPresponse received for SMTP ${smtpIndex + 1}`);
      return;
    }

    const responseCode = parseInt(response.substring(0, 3));

    if (responseCode >= 400 && responseCode < 500) {
      console.warn(
        `⚠️ Soft bounce detected for SMTP ${smtpIndex + 1}: ${response}`,
      );
    } else if (responseCode >= 500) {
      console.error(
        `❌ Hard bounce detected for SMTP ${smtpIndex + 1}: ${response}`,
      );
    } else if (responseCode >= 200 && responseCode < 300) {
      if (response.toLowerCase().includes("spam")) {
        console.warn(
          `⚠️ Possible spam issue detected for SMTP ${smtpIndex + 1}: ${response}`,
        );
      }
    }
  }

  detectSMTPProvider(hostname) {
    const host = hostname.toLowerCase();

    if (host.includes("gmail.com") || host.includes("googlemail.com"))
      return "gmail";
    if (
      host.includes("outlook.com") ||
      host.includes("hotmail.com") ||
      host.includes("live.com")
    )
      return "outlook";
    if (host.includes("yahoo.com") || host.includes("ymail.com"))
      return "yahoo";
    if (host.includes("aol.com")) return "aol";

    if (host.includes("amazonses.com")) return "ses";
    if (host.includes("sendgrid.net") || host.includes("sendgrid.com"))
      return "sendgrid";
    if (host.includes("mailgun.org")) return "mailgun";
    if (host.includes("mandrill.com")) return "mandrill";
    if (host.includes("sparkpost.com")) return "sparkpost";

    if (host.includes("mail.ru") || host.includes("yandex.ru"))
      return "russian";
    if (host.includes(".jp")) return "japanese";
    if (host.includes(".de")) return "german";
    if (host.includes(".cn")) return "chinese";

    return "generic";
  }

  generateSmartHeaders(smtp) {
    const provider = this.detectSMTPProvider(smtp.host);
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(7);
    const domain = this.extractDomainFromSMTP(smtp);

    const baseHeaders = {
      "MIME-Version": "1.0",
      Date: new Date().toUTCString(),
      "Message-ID": `<${timestamp}.${randomId}@${domain}>`,
      "X-Priority": "3",
      "List-Unsubscribe": `<mailto:unsubscribe@${domain}>, <https://${domain}/unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      "X-Auto-Response-Suppress": "OOF, AutoReply",
      "Return-Path": `<noreply@${domain}>`,
      "Reply-To": `noreply@${domain}`,
      "Errors-To": `bounce@${domain}`,
      "Feedback-ID": `${randomId}:${domain}:campaign`,
      "X-Report-Abuse": `Please report abuse to abuse@${domain}`,
      "X-Complaints-To": `complaints@${domain}`,
      Precedence: "bulk",
      "X-Mailer-Type": "bulk",
      "X-Campaign-ID": randomId,
    };

    const providerHeaders = this.getProviderSpecificHeaders(
      provider,
      smtp,
      domain,
      timestamp,
      randomId,
    );

    return {
      ...baseHeaders,
      ...providerHeaders,
    };
  }

  getProviderSpecificHeaders(provider, smtp, domain, timestamp, randomId) {
    switch (provider) {
      case "gmail":
        return {
          "X-Mailer": "Gmail",
          "X-Google-SMTP": "1",
        };

      case "outlook":
        return {
          "X-Mailer": "Microsoft Outlook 16.0",
          "X-MS-Exchange-Organization": domain,
          "X-MS-Has-Attach": "no",
        };

      case "yahoo":
        return {
          "X-Mailer": "YahooMailWebService/0.8.112",
          "X-Yahoo-SMTP": "1",
        };

      case "ses":
        return {
          "X-Mailer": "Amazon SES",
          "X-SES-Outgoing": timestamp.toString(),
          "X-SES-Configuration-Set": "default",
        };

      case "sendgrid":
        return {
          "X-Mailer": "SendGrid",
          "X-SG-EID": randomId,
          "X-SG-ID": `${timestamp}.${randomId}`,
        };

      case "japanese":
        return {
          "X-Mailer": this.generateJapaneseMailer(smtp.host),
          "List-Unsubscribe": `<mailto:unsubscribe@${domain}>, <https://${domain}/unsubscribe>`,
          "X-Campaign-ID": randomId,
          "X-Auto-Response-Suppress": "OOF, AutoReply",
          "Feedback-ID": `${randomId}:${domain}:campaign`,
          "X-Message-Source": "Automated",
          "X-Transport-ID": randomId,
        };

      case "generic":
      default:
        return {
          "X-Mailer": this.generateGenericMailer(smtp.host),
          "List-Unsubscribe": `<mailto:unsubscribe@${domain}>, <https://${domain}/unsubscribe>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          "X-Campaign-ID": randomId,
          "X-Message-ID": `${timestamp}-${randomId}`,
          "X-Sender-ID": domain,
          "X-Auto-Response-Suppress": "OOF, AutoReply",
          "X-Report-Abuse": `Please report abuse to abuse@${domain}`,
          "Feedback-ID": `${randomId}:${domain}:campaign`,
          "X-Server-Name": smtp.host,
          "X-Transport-ID": randomId,
          Importance: this.getRandomImportance(),
          "X-MSMail-Priority": this.getRandomMSPriority(),
          "Authentication-Results": `${domain}; dkim=pass; spf=pass; dmarc=pass`,
          "X-Spam-Status": "No",
          "X-Originating-IP": this.generateRandomIP(),
          "X-Priority": "3 (Normal)",
          "X-MS-Has-Attach": "no",
          "X-MS-TNEF-Correlator": randomId,
        };
    }
  }

  extractDomainFromSMTP(smtp) {
    try {
      if (
        smtp.fromEmail &&
        typeof smtp.fromEmail === "string" &&
        smtp.fromEmail.includes("@")
      ) {
        try {
          const fromDomain = smtp.fromEmail.split("@")[1];
          if (fromDomain && fromDomain.includes(".")) {
            return fromDomain.toLowerCase();
          }
        } catch (error) {
          // Continue to next fallback
        }
      }

      if (
        smtp.auth?.user &&
        typeof smtp.auth.user === "string" &&
        smtp.auth.user.includes("@")
      ) {
        try {
          const userDomain = smtp.auth.user.split("@")[1];
          if (userDomain && userDomain.includes(".")) {
            return userDomain.toLowerCase();
          }
        } catch (error) {
          // Continue to next fallback
        }
      }

      let domain = smtp.host;
      if (!domain || typeof domain !== "string") {
        console.warn("⚠️ SMTP host is invalid or missing");
        return process.env.DEFAULT_DOMAIN || "example.com";
      }

      domain = domain.toLowerCase();

      if (domain.includes("biglobe.ne.jp")) {
        return "biglobe.ne.jp";
      }
      if (domain.includes("nifty.")) {
        const niftyIndex = domain.indexOf("nifty.");
        return domain.substring(niftyIndex);
      }
      if (domain.includes("lolipop.jp")) {
        return "lolipop.jp";
      }

      domain = domain.replace(
        /^(smtp|mail|mx|mta-[^.]+|send|relay|out|outbound)\./,
        "",
      );

      const parts = domain.split(".");
      if (parts.length >= 2) {
        const validParts = parts.filter((part) => part.length > 0);
        if (validParts.length >= 2) {
          domain = validParts.slice(-2).join(".");
        }
      }

      if (domain && domain.includes(".") && domain.length > 3) {
        return domain;
      }

      if (smtp.host && typeof smtp.host === "string") {
        const cleanHost = smtp.host.replace(/^(smtp|mail|mx)\./i, "");
        if (cleanHost && cleanHost.includes(".")) {
          return cleanHost;
        }

        console.warn(`⚠️ Using fallback domain for SMTP: ${smtp.host}`);
        const fallbackHost = smtp.host.replace(/^(smtp|mail|mx)\./i, "");
        return process.env.DEFAULT_DOMAIN || fallbackHost || "mail-service.net";
      }

      return process.env.DEFAULT_DOMAIN || "example.com";
    } catch (error) {
      console.error(`❌ Error extracting domain from SMTP: ${error.message}`);
      return process.env.DEFAULT_DOMAIN || "example.com";
    }
  }

  generateJapaneseMailer(hostname) {
    if (hostname.includes("biglobe")) return "BIGLOBE Webmail";
    if (hostname.includes("nifty")) return "NIFTY Mail";
    if (hostname.includes("so-net")) return "So-net Mail";
    if (hostname.includes("ocn")) return "OCN Mail";
    return "Mail Server";
  }

  generateGenericMailer(hostname) {
    const cleanHost = hostname.replace(/^(smtp|mail|mx|send|relay)\.?/, "");
    const domainParts = cleanHost.split(".");

    if (domainParts.length >= 2) {
      const company =
        domainParts[0].charAt(0).toUpperCase() + domainParts[0].slice(1);

      const mailerTypes = [
        `${company} Mail Server`,
        `${company} Email System`,
        `${company} SMTP Service`,
        `${company} Mail Gateway`,
        `${company} Messaging Server`,
      ];

      return mailerTypes[Math.floor(Math.random() * mailerTypes.length)];
    }

    const versions = ["v2.1", "v2.3", "v3.0", "v3.2"];
    const version = versions[Math.floor(Math.random() * versions.length)];
    return `Mail Server ${version}`;
  }

  generateRandomIP() {
    return Array.from({ length: 4 }, () =>
      Math.floor(Math.random() * 256),
    ).join(".");
  }

  getRandomImportance() {
    const priorities = ["Low", "Normal", "High"];
    return priorities[Math.floor(Math.random() * priorities.length)];
  }

  getRandomMSPriority() {
    const priorities = ["Low", "Normal", "High"];
    return priorities[Math.floor(Math.random() * priorities.length)];
  }

  getEmailHeaders(smtp, recipientEmail = null) {
    try {
      if (config.headers?.smartDetection?.enabled) {
        const smartHeaders = this.generateSmartHeaders(smtp);
        if (config.headers.smartDetection.randomization) {
          return this.addRandomization(smartHeaders, recipientEmail);
        }
        return smartHeaders;
      }

      if (
        config.headers?.rotation?.enabled &&
        config.headers.rotation.rotationList?.length > 0
      ) {
        const strategy = config.headers?.rotation?.strategy || "sequential";
        let rotationIndex;

        if (strategy === "random") {
          // Random selection
          rotationIndex = Math.floor(
            Math.random() * config.headers.rotation.rotationList.length,
          );
        } else {
          // Sequential rotation (default)
          rotationIndex = this.atomicCounters.currentHeaderIndex;
          this.atomicCounters.currentHeaderIndex =
            (this.atomicCounters.currentHeaderIndex + 1) %
            config.headers.rotation.rotationList.length;
        }

        const headers = {
          ...config.headers.rotation.rotationList[rotationIndex],
        };
        return this.processTemplateVariables(headers, smtp, recipientEmail);
      }

      if (config.headers?.defaultHeaders?.enabled) {
        const headers = { ...config.headers.defaultHeaders.headers };
        return this.processTemplateVariables(headers, smtp, recipientEmail);
      }

      return {
        "MIME-Version": "1.0",
        Date: new Date().toUTCString(),
        "X-Mailer": "Mail Server",
      };
    } catch (error) {
      console.warn("Error generating email headers:", error.message);
      return {
        "MIME-Version": "1.0",
        Date: new Date().toUTCString(),
      };
    }
  }

  addRandomization(headers, recipientEmail = null) {
    const randomizedHeaders = { ...headers };
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(7);

    if (randomizedHeaders["X-Priority"]) {
      randomizedHeaders["X-Priority"] = ["1", "3", "5"][
        Math.floor(Math.random() * 3)
      ];
    }
    if (
      randomizedHeaders["Message-ID"] &&
      !randomizedHeaders["Message-ID"].includes(timestamp)
    ) {
      const domain =
        recipientEmail && recipientEmail.includes("@")
          ? recipientEmail.split("@")[1]
          : "example.com";
      randomizedHeaders["Message-ID"] = `<${timestamp}.${randomId}@${domain}>`;
    }

    return randomizedHeaders;
  }

  processTemplateVariables(headers, smtp, recipientEmail = null) {
    const processedHeaders = {};
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(7);
    const smtpDomain = this.extractDomainFromSMTP(smtp);
    const currentDateTime = new Date().toUTCString();

    const recipientDomain =
      recipientEmail && recipientEmail.includes("@")
        ? recipientEmail.split("@")[1]
        : smtpDomain;

    const variables = {
      "{{timestamp}}": timestamp.toString(),
      "{{randomId}}": randomId,
      "{{domain}}": recipientDomain,
      "{{smtpDomain}}": smtpDomain,
      "{{email}}": recipientEmail || "user@example.com",
      "{{user}}": recipientEmail ? recipientEmail.split("@")[0] : "user",
      "{{currentDateTime}}": currentDateTime,
      "{{randomFirstName}}": ["John", "Jane", "Alex", "Sarah"][
        Math.floor(Math.random() * 4)
      ],
      "{{randomFutureDate}}": new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000,
      ).toUTCString(),
    };

    Object.entries(headers).forEach(([key, value]) => {
      let processedValue = String(value);
      Object.entries(variables).forEach(([placeholder, replacement]) => {
        processedValue = processedValue.replace(
          new RegExp(placeholder.replace(/[{}]/g, "\\$&"), "g"),
          replacement,
        );
      });
      processedHeaders[key] = processedValue;
    });

    return processedHeaders;
  }

  htmlToText(html) {
    if (!html) return "";
    return html
      .replace(/<style[^>]*>.*?<\/style>/gis, "")
      .replace(/<script[^>]*>.*?<\/script>/gis, "")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  logEmailDetails(smtp, mailOptions, selectedSmtpIndex, emailNumber) {
    const templateName =
      mailOptions.templateFile?.split("/").pop() || "default.html";
    const totalSent =
      emailNumber ||
      this.emailsSentPerSmtp.reduce((sum, count) => sum + count, 0) + 1;

    const displayFrom = mailOptions.actualSenderName
      ? `"${mailOptions.actualSenderName}" <${smtp.fromEmail}>`
      : mailOptions.from;

    console.log(
      chalk.blue(`#${totalSent}: `) +
        chalk.white(
          `${mailOptions.to} | ${mailOptions.subject} | ${templateName} | ${displayFrom}`,
        ) +
        chalk.yellow(` [SMTP ${selectedSmtpIndex + 1}] `) +
        chalk.green("✓ Sent"),
    );

    if (config.email?.optimization?.enabled) {
      console.log(
        chalk.gray(
          `  ├─ HTML Optimized: ${mailOptions.html !== mailOptions.originalHtml ? "✓" : "─"}`,
        ),
      );
      console.log(
        chalk.gray(`  ├─ Text Version: ${mailOptions.text ? "✓" : "─"}`),
      );
      console.log(
        chalk.gray(
          `  └─ Headers: ${Object.keys(mailOptions.headers || {}).length} applied`,
        ),
      );
    }
  }

  getSmtpStatus() {
    return {
      currentIndex: this.atomicCounters.currentSmtpIndex,
      lastUsedIndex: this.lastUsedSmtpIndex,
      emailsSentPerSmtp: [...this.emailsSentPerSmtp],
      totalSmtpServers: this.rotationEnabled ? this.smtpConfigs.length : 1,
      rotationEnabled: this.rotationEnabled,
      rotationStrategy: config.smtp?.rotation?.strategy || "sequential",
      healthyServers: this.getAvailableSMTPs().length,
      transportPoolSize:
        this.poolingEnabled && this.transportPool ? this.transportPool.size : 0,
      optimizedMode: this.rotationEnabled ? "rotation" : "single_smtp",
    };
  }

  async cleanup() {
    console.log("🧹 Cleaning up SMTP Manager...");

    // Clear pool cleanup interval
    if (this.poolCleanupInterval) {
      clearInterval(this.poolCleanupInterval);
      this.poolCleanupInterval = null;
    }

    // Clear cooldown timers
    for (const [smtpIndex, timerId] of this.cooldownTimers) {
      clearTimeout(timerId);
    }
    this.cooldownTimers.clear();

    // Cleanup from address rotators
    for (const [smtpIndex, rotator] of this.fromAddressRotators) {
      if (typeof rotator.cleanup === "function") {
        await rotator.cleanup();
      }
    }
    this.fromAddressRotators.clear();

    // Cleanup proxy rotation manager
    if (
      this.proxyRotation &&
      typeof this.proxyRotation.cleanup === "function"
    ) {
      await this.proxyRotation.cleanup();
    }
    this.proxyRotation = null;

    // FIX: Thread-safe transport pool cleanup
    if (this.poolingEnabled && this.transportPool) {
      await this.rateLimitMutex.acquire();
      try {
        console.log(
          `🔌 Closing ${this.transportPool.size} pooled transport connections...`,
        );

        // Get snapshot of transports to prevent concurrent modification
        const transportsToClose = Array.from(
          this.transportPool.cache.entries(),
        );

        // Clear pool first to prevent new connections being added
        this.transportPool.clear();

        // Close all transports from snapshot
        for (const [key, transport] of transportsToClose) {
          try {
            this._safeCloseTransport(transport);
          } catch (error) {
            console.warn(`⚠️ Error closing transport ${key}: ${error.message}`);
          }
        }
      } finally {
        this.rateLimitMutex.release();
      }
    }

    console.log("✅ SMTP Manager cleanup completed");
  }

  getCoordinationStatus() {
    const activeSmtps = this.perSmtpRateLimiting.filter(
      (r) => !r.isCoolingDown && !r.isLimited,
    ).length;
    const coolingSmtps = this.perSmtpRateLimiting.filter(
      (r) => r.isCoolingDown,
    ).length;

    return {
      totalSmtps: this.smtpConfigs.length,
      activeSmtps: activeSmtps,
      coolingSmtps: coolingSmtps,
      activeThreads: 1, // Simplified
      rateLimitStatus: this.perSmtpRateLimiting.map((r, i) => ({
        smtpIndex: i + 1,
        emailsSent: r.emailsSentInCurrentMinute,
        limit: r.emailsPerMinute,
        isCoolingDown: r.isCoolingDown,
        isLimited: r.isLimited,
        cooldownTimeLeft: r.isCoolingDown
          ? Math.max(0, r.cooldownStartTime + r.cooldownDuration - Date.now())
          : 0,
      })),
    };
  }

  async preCompileAllTemplates() {
    const templateFiles = new Set();

    // Add default template
    if (config.email?.templates?.default) {
      templateFiles.add(config.email.templates.default);
    }

    // Only add rotation templates if rotation is enabled (OPTIMIZATION)
    if (
      config.email?.templates?.rotation?.enabled &&
      config.email?.templates?.rotation?.files
    ) {
      config.email.templates.rotation.files.forEach((file) =>
        templateFiles.add(file),
      );
      console.log(
        `🔄 Template rotation enabled: including ${config.email.templates.rotation.files.length} rotation templates for pre-compilation`,
      );
    } else {
      console.log(
        `🎯 Template rotation disabled: pre-compiling only default template for optimal performance`,
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

  async preCompileTemplate(templateFile) {
    // Placeholder for actual pre-compilation logic (e.g., Handlebars, etc.)
    console.log(`🔨 Pre-compiling template: ${templateFile}`);
  }
}

// ===== CONTENT OPTIMIZATION FUNCTIONS =====
function checkForSpamTriggers(content) {
  if (!content) return [];
  const foundTriggers = [];

  const spamTriggers = [
    /\b(FREE|URGENT|ACT NOW|LIMITED TIME|CLICK HERE)\b/gi,
    /\b(MAKE MONEY|EARN CASH|NO RISK|GUARANTEED)\b/gi,
    /\b(CONGRATULATIONS|YOU'VE WON|CLAIM NOW)\b/gi,
    /\b(AMAZING DEAL|WINNER|CASH PRIZE)\b/gi,
    /\b(DON'T MISS|ACT NOW|LIMITED TIME)\b/gi,
    /\b(VIAGRA|PHARMACY|CREDIT SCORE|DEBT)\b/gi,
    /\b(REFINANCE|MORTGAGE|INSURANCE|CASINO)\b/gi,
    /\b(MIRACLE|BREAKTHROUGH|SECRET)\b/gi,
    /\b(LOSE WEIGHT|DIET|PILLS)\b/gi,
    /\b(100% FREE|RISK FREE|NO OBLIGATION|SATISFACTION GUARANTEED)\b/gi,
    /\b(ONCE IN A LIFETIME|LIMITED OFFER|EXCLUSIVE DEAL)\b/gi,
    /\b(CALL NOW|ORDER NOW|APPLY NOW|DOWNLOAD NOW)\b/gi,
    /\b(WEIGHT LOSS|MAKE \$|EARN \$|EASY MONEY)\b/gi,
    /\b(WORK FROM HOME|BE YOUR OWN BOSS|FINANCIAL FREEDOM)\b/gi,
    /\b(STOP SNORING|ANTI-AGING|HAIR LOSS|PENIS ENLARGEMENT)\b/gi,
    /\b(MEET SINGLES|ADULT ENTERTAINMENT|XXX|PORN)\b/gi,
    /\b(CLICK BELOW|CLICK TO REMOVE|UNSUBSCRIBE)\b/gi,
  ];

  spamTriggers.forEach((pattern, index) => {
    const matches = content.match(pattern);
    if (matches) {
      foundTriggers.push({
        type: "spam_word",
        value: matches.join(", "),
        severity: "high",
        pattern: pattern,
        matches: matches,
      });
    }
  });

  const exclamationCount = (content.match(/!/g) || []).length;
  if (exclamationCount > 2) {
    foundTriggers.push({
      type: "excessive_punctuation",
      value: `${exclamationCount} exclamation marks`,
      severity: "medium",
    });
  }

  const capsMatches = content.match(/[A-Z]{5,}/g);
  if (capsMatches && capsMatches.length > 0) {
    foundTriggers.push({
      type: "excessive_caps",
      value: capsMatches.join(", "),
      severity: "medium",
    });
  }

  const dollarCount = (content.match(/\$/g) || []).length;
  if (dollarCount > 2) {
    foundTriggers.push({
      type: "excessive_money_symbols",
      value: `${dollarCount} dollar signs`,
      severity: "medium",
    });
  }

  if (content.match(/\b\d+%\s+(OFF|DISCOUNT|SAVINGS?)\b/gi)) {
    foundTriggers.push({
      type: "discount_percentage",
      value: "percentage discount detected",
      severity: "low",
    });
  }

  return foundTriggers;
}

function removeSpamTriggers(content, options = {}) {
  if (!content || typeof content !== "string") {
    return {
      content: content,
      triggersRemoved: 0,
      originalLength: 0,
      newLength: 0,
      removedTriggers: [],
    };
  }

  const mode = options.mode || "mask"; // 'mask', 'remove', 'replace'
  const replacement = options.replacement || "***";

  let processedContent = content;
  let removedCount = 0;
  let removedTriggers = [];

  const spamTriggers = [
    /\b(FREE|URGENT|ACT NOW|LIMITED TIME|CLICK HERE)\b/gi,
    /\b(MAKE MONEY|EARN CASH|NO RISK|GUARANTEED)\b/gi,
    /\b(CONGRATULATIONS|YOU'VE WON|CLAIM NOW)\b/gi,
    /\b(AMAZING DEAL|WINNER|CASH PRIZE)\b/gi,
    /\b(DON'T MISS|ACT NOW|LIMITED TIME)\b/gi,
    /\b(VIAGRA|PHARMACY|CREDIT SCORE|DEBT)\b/gi,
    /\b(REFINANCE|MORTGAGE|INSURANCE|CASINO)\b/gi,
    /\b(MIRACLE|BREAKTHROUGH|SECRET)\b/gi,
    /\b(LOSE WEIGHT|DIET|PILLS)\b/gi,
    /\b(100% FREE|RISK FREE|NO OBLIGATION|SATISFACTION GUARANTEED)\b/gi,
    /\b(ONCE IN A LIFETIME|LIMITED OFFER|EXCLUSIVE DEAL)\b/gi,
    /\b(CALL NOW|ORDER NOW|APPLY NOW|DOWNLOAD NOW)\b/gi,
    /\b(WEIGHT LOSS|MAKE \$|EARN \$|EASY MONEY)\b/gi,
    /\b(WORK FROM HOME|BE YOUR OWN BOSS|FINANCIAL FREEDOM)\b/gi,
    /\b(STOP SNORING|ANTI-AGING|HAIR LOSS|PENIS ENLARGEMENT)\b/gi,
    /\b(MEET SINGLES|ADULT ENTERTAINMENT|XXX|PORN)\b/gi,
    /\b(CLICK BELOW|CLICK TO REMOVE|UNSUBSCRIBE)\b/gi,
  ];

  spamTriggers.forEach((pattern) => {
    const matches = processedContent.match(pattern);
    if (matches) {
      matches.forEach((match) => {
        const originalMatch = match;
        switch (mode) {
          case "remove":
            processedContent = processedContent.replace(
              new RegExp(escapeRegex(match), "gi"),
              "",
            );
            break;
          case "replace":
            processedContent = processedContent.replace(
              new RegExp(escapeRegex(match), "gi"),
              replacement,
            );
            break;
          case "mask":
          default:
            // Mask with asterisks while preserving length
            const masked = "*".repeat(match.length);
            processedContent = processedContent.replace(
              new RegExp(escapeRegex(match), "gi"),
              masked,
            );
            break;
        }
        removedCount++;
        removedTriggers.push({
          original: originalMatch,
          mode: mode,
          replacement:
            mode === "mask"
              ? "*".repeat(match.length)
              : mode === "replace"
                ? replacement
                : "[removed]",
        });
      });
    }
  });

  // Clean up extra spaces from removals
  if (mode === "remove") {
    processedContent = processedContent.replace(/\s+/g, " ").trim();
  }

  return {
    content: processedContent,
    triggersRemoved: removedCount,
    originalLength: content.length,
    newLength: processedContent.length,
    removedTriggers: removedTriggers,
  };
}

// Helper function to escape regex special characters
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function optimizeHtmlContent(html, optimizationConfig = {}) {
  try {
    const $ = cheerio.load(html, {
      decodeEntities: false,
      normalizeWhitespace: false,
    });

    $("blink, marquee, embed, object, script, iframe").remove();

    $('[style*="font-size: 1px"], [style*="font-size:1px"]').remove();
    $('[style*="color: white"], [style*="color:white"]')
      .filter(function () {
        return (
          $(this).css("background-color") === "white" ||
          $(this).css("background") === "white"
        );
      })
      .remove();

    $("img:not([alt])").attr("alt", "Image");

    $('[style*="!important"]').each((i, el) => {
      const style = $(el).attr("style");
      $(el).attr("style", style.replace(/!important/g, ""));
    });

    $('[style*="text-decoration: none"]').each((i, el) => {
      const $el = $(el);
      if ($el.is("a")) {
        $el.removeAttr("style");
      }
    });

    const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    $("body").prepend(`<!-- ${messageId} -->`);

    $("a").each((i, el) => {
      $(el).attr("rel", "noopener noreferrer");
      if (!$(el).attr("title")) {
        $(el).attr("title", $(el).text().trim());
      }
      if (!$(el).attr("href") || $(el).attr("href") === "#") {
        $(el).attr("href", "javascript:void(0)");
      }
    });

    if (!$("meta[charset]").length) {
      $("head").prepend('<meta charset="UTF-8">');
    }

    if (!$('meta[name="viewport"]').length) {
      $("head").append(
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      );
    }

    $('[style*="display:none"], [style*="display: none"]').remove();
    $('[style*="visibility:hidden"], [style*="visibility: hidden"]').remove();

    let optimizedHtml = $.html();
    let spamRemovalResult = null;

    // NEW: Spam trigger removal if enabled
    if (
      config.email.optimization.enabled &&
      config.email.optimization.removeSpamTriggers
    ) {
      spamRemovalResult = removeSpamTriggers(optimizedHtml, {
        mode: optimizationConfig.spamRemovalMode || "mask",
        replacement: optimizationConfig.spamReplacement || "***",
      });

      optimizedHtml = spamRemovalResult.content;
    }

    return {
      html: optimizedHtml,
      messageId,
      spamRemoval: spamRemovalResult,
    };
  } catch (error) {
    console.error("HTML optimization failed:", error);
    return { html, messageId: "", spamRemoval: null };
  }
}

// ===== UNIFIED ROTATION MANAGER FACTORY =====
class RotationManagerFactory {
  static createTemplateRotation(config) {
    const templateItems =
      config.email?.templates?.rotation?.files &&
      config.email.templates.rotation.files.length > 0
        ? config.email.templates.rotation.files
        : [config.email?.templates?.default || "template1.html"];

    return new RotationManager(templateItems, "templates", config);
  }

  static createSubjectRotation(config) {
    const subjectItems =
      config.email?.subject?.rotation?.templates &&
      config.email.subject.rotation.templates.length > 0
        ? config.email.subject.rotation.templates
        : ["Default Subject"];

    return new RotationManager(subjectItems, "subjects", config);
  }

  static createSenderRotation(config) {
    const senderItems =
      config.email?.senderName?.rotation?.names &&
      config.email.senderName.rotation.names.length > 0
        ? config.email.senderName.rotation.names
        : [""];

    return new RotationManager(senderItems, "senderName", config);
  }
}

// ✅ UNIFIED: Single instance creation with proper error handling and singleton pattern
let templateRotation, subjectRotation, senderRotation;
let managersInitialized = false;

function initializeRotationManagers() {
  // Prevent multiple initializations
  if (managersInitialized) {
    return true;
  }

  try {
    templateRotation = RotationManagerFactory.createTemplateRotation(config);
    subjectRotation = RotationManagerFactory.createSubjectRotation(config);
    senderRotation = RotationManagerFactory.createSenderRotation(config);

    managersInitialized = true;
    console.log("✅ Unified rotation managers initialized successfully");
    return true;
  } catch (error) {
    console.error(`Failed to initialize rotation managers: ${error.message}`);

    // Create minimal fallback instances
    templateRotation = new RotationManager(
      [config.email?.templates?.default || "template1.html"],
      "templates",
      config,
    );
    subjectRotation = new RotationManager(
      ["Default Subject"],
      "subjects",
      config,
    );
    senderRotation = new RotationManager([""], "senderName", config);

    managersInitialized = true;
    console.log("⚠️ Using fallback rotation managers");
    return false;
  }
}

// Initialize rotation managers once
initializeRotationManagers();

// Export getter function for SMTP manager compatibility
const getSenderNameRotation = () => senderRotation;

// ✅ CLEAN: Single unified export structure
export default SMTPManager;
export {
  RotationManager,
  DynamicContentProcessor,
  checkForSpamTriggers,
  removeSpamTriggers,
  optimizeHtmlContent,
  RotationManagerFactory,
  getSenderNameRotation,
  AsyncMutex,
  templateRotation,
  subjectRotation,
  senderRotation,
};