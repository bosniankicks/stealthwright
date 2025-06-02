/**
 * StealthWright Browser Module
 * 
 * This module manages browser instances and provides connection to Chrome DevTools Protocol.
 * It includes proxy management, navigation, and browser lifecycle handling.
 */

const fs = require('fs-extra');
const path = require('path');
const http = require('http');
const { WebSocket } = require('ws');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const rimraf = require('rimraf');
const { getChromePath } = require('./utils/chrome-finder');
const { errors } = require('./errors');
const Page = require('./page');

// Default user data directory for browser profiles
const DEFAULT_USER_DATA_DIR = path.join(os.tmpdir(), 'stealthwright-data');

/**
 * Get a random proxy from the proxies file or list
 * @param {string|Array} proxies - Path to proxies file or array of proxy strings
 * @returns {string|null} A randomly selected proxy or null if none available
 */
function getRandomProxy(proxies) {
  try {
    let proxyList = [];
    
    if (typeof proxies === 'string') {
      // If proxies is a file path
      if (fs.existsSync(proxies)) {
        const proxiesContent = fs.readFileSync(proxies, 'utf8');
        proxyList = proxiesContent.split('\n')
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#'));
      }
    } else if (Array.isArray(proxies)) {
      // If proxies is already an array
      proxyList = proxies.filter(p => p && typeof p === 'string');
    }

    if (proxyList.length === 0) {
      console.warn('No valid proxies found');
      return null;
    }

    // Select a random proxy
    const randomIndex = Math.floor(Math.random() * proxyList.length);
    const selectedProxy = proxyList[randomIndex];

    return selectedProxy;
  } catch (error) {
    console.error(`Failed to load proxies: ${error.message}`);
    return null;
  }
}

/**
 * Parse proxy URL to extract components
 * Supports IP:PORT:USERNAME:PASSWORD and traditional URL formats
 * @param {string} proxyUrl - The proxy URL to parse
 * @returns {Object|null} - Parsed proxy information or null if parsing failed
 */
function parseProxyUrl(proxyUrl) {
  try {
    let protocol = 'http'; // Default to http protocol
    let username, password, host, port;

    // Check if the format is IP:PORT:USERNAME:PASSWORD
    const parts = proxyUrl.split(':');
    if (proxyUrl.includes('@')) {
      // Traditional URL format: protocol://username:password@host:port
      if (proxyUrl.includes('://')) {
        [protocol, proxyUrl] = proxyUrl.split('://');
      }

      const [auth, hostPort] = proxyUrl.split('@');
      [username, password] = auth.split(':');

      if (hostPort.includes(':')) {
        [host, port] = hostPort.split(':');
      } else {
        host = hostPort;
        port = protocol === 'https' ? 443 : 80; // Default ports
      }
    } else if (parts.length === 4) {
      // Format is IP:PORT:USERNAME:PASSWORD
      [host, port, username, password] = parts;
    } else if (parts.length === 2) {
      // Simple IP:PORT format
      [host, port] = parts;
    } else {
      throw new Error(`Unsupported proxy format: ${proxyUrl}`);
    }

    port = parseInt(port, 10);

    return {
      protocol,
      username,
      password,
      host,
      port,
      // For Chrome's --proxy-server argument (without auth)
      proxyServer: `${protocol}://${host}:${port}`,
      // These are still useful for other purposes
      hasAuth: !!(username && password),
      authString: username && password ? `${username}:${password}` : null,
      // For logging (hide password for security)
      display: username && password
        ? `${protocol}://${host}:${port} (with auth)`
        : `${protocol}://${host}:${port}`
    };
  } catch (error) {
    console.error(`Failed to parse proxy URL: ${error.message}`);
    return null;
  }
}

/**
 * Browser class for managing Chrome/Chromium instances
 */
class Browser {
  /**
   * Create a new Browser instance
   * @param {string} execPath - Path to Chrome/Chromium executable
   * @param {Object} options - Browser options
   */
  constructor(execPath, options = {}) {
    this.execPath = execPath;
    this.wsEndpoint = null;
    this.conn = null;
    this.childProcess = null;
    this.userDataDir = options.userDataDir || path.join(os.tmpdir(), `stealthwright_${uuidv4()}`);
    this.messageId = 0;
    this.pid = null;
    this.isHeadless = options.headless !== undefined ? options.headless : false;
    this.debugPort = options.port || Math.floor(Math.random() * (9999 - 9000 + 1)) + 9000; // Random port between 9000-9999
    this.proxy = null;
    this.authHandlersSetup = false;
    this._messageCallbacks = new Map();
    this.extraArgs = options.args || [];
    this.contexts = new Set();
    this.defaultContext = null;
    this.ignoreHTTPSErrors = options.ignoreHTTPSErrors || false;
    this.initialTargetId = null;
  }

  /**
   * Launch the browser
   * @param {Object} options - Launch options
   * @returns {Promise<Browser>} - Browser instance
   */
  async launch(options = {}) {
    try {
      // Parse launch options
      const startURL = options.startURL || 'about:blank';
      const useProxy = options.proxy || false;

      // Get a random proxy if enabled
      if (useProxy) {
        let proxyUrl;
        if (typeof useProxy === 'string') {
          proxyUrl = useProxy;
        } else if (Array.isArray(options.proxyList)) {
          proxyUrl = getRandomProxy(options.proxyList);
        } else if (options.proxyFile) {
          proxyUrl = getRandomProxy(options.proxyFile);
        }

        if (proxyUrl) {
          const parsedProxy = parseProxyUrl(proxyUrl);
          if (parsedProxy) {
            this.proxy = parsedProxy;
            console.log(`Using proxy: ${parsedProxy.display}`);
          }
        }
      }

      // Set up Chrome arguments
      const args = [
        `--remote-debugging-port=${this.debugPort}`,
        '--no-first-run',
        `--user-data-dir=${this.userDataDir}`,
        '--remote-allow-origins=*'
      ];

      // Add proxy argument if we have a proxy
      if (this.proxy) {
        args.push(`--proxy-server=${this.proxy.proxyServer}`);
      }

      // Add headless mode if specified
      if (this.isHeadless) {
        args.push('--headless=new');
      }

      // Add HTTPS error handling
      if (this.ignoreHTTPSErrors) {
        args.push('--ignore-certificate-errors');
      }

      // Add any extra arguments
      args.push(...this.extraArgs);

      // Set initial URL based on startURL option
      const initialURL = startURL || 'about:blank';
      args.push(initialURL);

      console.log("Launching Chrome with args:", args.join(" "));
      console.log("Using browser executable:", this.execPath);

      this.childProcess = spawn(this.execPath, args);
      this.pid = this.childProcess.pid;
      console.log(`Chrome started with PID: ${this.pid}`);

      // Handle potential errors
      this.childProcess.on('error', (err) => {
        console.error(`Failed to start browser process: ${err}`);
        this.close();
        throw new errors.BrowserLaunchError(`Failed to launch browser: ${err.message}`);
      });

      this.childProcess.stderr.on('data', (data) => {
        // Log stderr output for debugging proxy issues
        const stderr = data.toString();
        if (stderr.includes("ERROR") || stderr.includes("proxy") || stderr.includes("auth")) {
          console.error(`Chrome stderr: ${stderr}`);
        }
      });

      this.childProcess.on('exit', (code, signal) => {
        console.log(`Browser process exited with code ${code} and signal ${signal}`);
        this.conn = null;
      });

      // Wait for browser to initialize
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Connect to Chrome
      await this.attachToPage();

      // Set up auth handlers immediately if using a proxy with auth
      if (this.proxy && this.proxy.hasAuth) {
        await this.setupAuthHandlers(this.proxy.username, this.proxy.password);
      }

      // Create a default browser context
      this.defaultContext = await this.createBrowserContext();

      return this;
    } catch (error) {
      console.error(`Failed to launch browser: ${error}`);
      await this.close();
      throw error;
    }
  }

  /**
   * Create a new browser context (similar to Playwright)
   * @returns {Promise<BrowserContext>} - Browser context instance
   */
  async createBrowserContext() {
    const context = new BrowserContext(this);
    this.contexts.add(context);
    return context;
  }

  /**
   * Get the default browser context
   * @returns {BrowserContext} - Default browser context
   */
  defaultBrowserContext() {
    return this.defaultContext;
  }

  /**
   * Set up proxy authentication handlers
   * @param {string} username - Proxy username
   * @param {string} password - Proxy password
   * @returns {Promise<boolean>} - True if auth handlers were set up successfully
   */
  async setupAuthHandlers(username, password) {
    try {
      console.log(`Setting up auth handlers with username: ${username} and password: [hidden]`);

      // First, enable both Network and Fetch domains
      await this.sendCommand("Network.enable", {});
      await this.sendCommand("Fetch.enable", {
        handleAuthRequests: true
      });

      // Set up a callback for auth events
      const self = this;

      // Using a named function so we can remove it if needed
      this.authEventHandler = async function (data) {
        try {
          const message = JSON.parse(data.toString());

          // Handle Network auth required events
          if (message.method === 'Network.authRequired') {
            const requestId = message.params.requestId;
            console.log(`Network auth required for request ID: ${requestId}`);

            try {
              // Respond with authentication credentials
              await self.sendCommand('Network.provideAuthCredentials', {
                requestId: requestId,
                authChallengeResponse: {
                  response: 'ProvideCredentials',
                  username: username,
                  password: password
                }
              });
              console.log(`Network: Provided credentials for request ID: ${requestId}`);
            } catch (err) {
              console.error(`Failed to provide Network auth credentials: ${err}`);
            }
          }

          // Handle Fetch auth required events
          if (message.method === 'Fetch.authRequired') {
            const requestId = message.params.requestId;
            console.log(`Fetch auth required for request ID: ${requestId}`);

            try {
              // Respond with authentication credentials
              await self.sendCommand('Fetch.continueWithAuth', {
                requestId: requestId,
                authChallengeResponse: {
                  response: 'ProvideCredentials',
                  username: username,
                  password: password
                }
              });
              console.log(`Fetch: Provided credentials for request ID: ${requestId}`);
            } catch (err) {
              console.error(`Failed to provide Fetch auth credentials: ${err}`);
            }
          }

          // Handle paused requests (needed to continue after auth)
          if (message.method === 'Fetch.requestPaused') {
            const requestId = message.params.requestId;

            try {
              await self.sendCommand('Fetch.continueRequest', {
                requestId: requestId
              });
            } catch (err) {
              console.error(`Failed to continue request: ${err}`);
            }
          }
        } catch (error) {
          // Ignore parsing errors
        }
      };

      // Add the event handler
      this.conn.on('message', this.authEventHandler);

      // Make several authenticated test requests to trigger auth
      console.log("Making test request to trigger proxy authentication...");
      await this.sendCommand("Runtime.evaluate", {
        expression: `
          // Make multiple test requests to ensure auth is triggered
          Promise.all([
            fetch('https://example.org/').catch(e => console.log('Test request error:', e)),
            fetch('https://httpbin.org/ip').catch(e => console.log('Test request error:', e))
          ]).then(() => console.log('Auth test requests completed'));
        `
      });

      console.log(`Auth handlers set up for user: ${username}`);
      this.authHandlersSetup = true;

      // Wait a moment for the auth test request to complete
      await new Promise(resolve => setTimeout(resolve, 2000));

      return true;
    } catch (error) {
      console.error(`Failed to set up auth handlers: ${error}`);
      return false;
    }
  }

  /**
   * Attach to a Chrome page
   * @returns {Promise<void>}
   */
  async attachToPage() {
    try {
      // Fetch list of available pages
      const pages = await new Promise((resolve, reject) => {
        const maxRetries = 20;
        let retries = 0;

        const tryConnect = () => {
          http.get(`http://localhost:${this.debugPort}/json`, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                if (retries < maxRetries) {
                  retries++;
                  console.log(`Failed to parse JSON, retrying (${retries}/${maxRetries})...`);
                  setTimeout(tryConnect, 1000);
                } else {
                  reject(new Error(`Failed to parse JSON: ${e.message}`));
                }
              }
            });
          }).on('error', (err) => {
            if (retries < maxRetries) {
              retries++;
              console.log(`Failed to connect to debugger, retrying (${retries}/${maxRetries})...`);
              setTimeout(tryConnect, 1000);
            } else {
              reject(new Error(`Failed to fetch active pages: ${err.message}`));
            }
          });
        };

        tryConnect();
      });

      // Find a suitable page to connect to
      for (const page of pages) {
        if (page.type === 'page') {
          const wsURL = page.webSocketDebuggerUrl;
          if (wsURL) {
            if (this.conn) {
              this.conn.close();
            }

            // Store the initial page target ID
            this.initialTargetId = page.id;

            // Connect to the page using WebSocket
            this.conn = new WebSocket(wsURL);

            await new Promise((resolve, reject) => {
              this.conn.on('open', () => {
                this.wsEndpoint = wsURL;
                console.log(`Connected to page: ${page.url}`);
                resolve();
              });

              this.conn.on('error', (err) => {
                reject(new Error(`WebSocket connection error: ${err.message}`));
              });
            });

            // Set up message handling
            this.setupMessageHandling();

            // Enable required domains
            await this.sendCommand("Page.enable", {});

            return;
          }
        }
      }

      throw new Error('No suitable page found');
    } catch (error) {
      console.error(`Failed to attach to page: ${error}`);
      throw error;
    }
  }

  /**
   * Set up WebSocket message handling
   */
  setupMessageHandling() {
    this.conn.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());

        // Handle command responses
        if (message.id !== undefined) {
          const callback = this._messageCallbacks.get(message.id);
          if (callback) {
            callback.resolve(message);
            this._messageCallbacks.delete(message.id);
          }
        }
      } catch (error) {
        // Ignore parsing errors
      }
    });

    this.conn.on('close', () => {
      console.log('WebSocket connection closed');
      // Reject all pending requests
      for (const [id, callback] of this._messageCallbacks.entries()) {
        callback.reject(new Error('WebSocket connection closed'));
        this._messageCallbacks.delete(id);
      }
    });

    this.conn.on('error', (error) => {
      console.error(`WebSocket error: ${error}`);
    });
  }

  /**
   * Send a CDP command and wait for response
   * @param {string} method - CDP method name
   * @param {Object} params - CDP command parameters
   * @returns {Promise<Object>} - CDP response
   */
  async sendCommand(method, params = {}) {
    if (!this.conn || this.conn.readyState !== WebSocket.OPEN) {
      try {
        await this.attachToPage();
      } catch (error) {
        throw new Error(`Failed to reconnect WebSocket: ${error.message}`);
      }
    }

    this.messageId++;
    const id = this.messageId;

    const message = {
      id,
      method,
      params: params || {}
    };

    return new Promise((resolve, reject) => {
      this._messageCallbacks.set(id, { resolve, reject });

      this.conn.send(JSON.stringify(message), (err) => {
        if (err) {
          this._messageCallbacks.delete(id);
          reject(new Error(`Failed to send WebSocket message: ${err.message}`));
        }

        // Set timeout for response
        setTimeout(() => {
          if (this._messageCallbacks.has(id)) {
            this._messageCallbacks.delete(id);
            reject(new Error(`Command ${method} timed out after 30 seconds`));
          }
        }, 30000);
      });
    });
  }

  /**
   * Close the browser
   * @returns {Promise<void>}
   */
  async close() {
    try {
      // Close all browser contexts first
      for (const context of this.contexts) {
        await context.close();
      }
      this.contexts.clear();
      this.defaultContext = null;

      if (this.conn) {
        // Remove auth event handler if it exists
        if (this.authEventHandler) {
          this.conn.removeListener('message', this.authEventHandler);
        }

        this.conn.close();
        this.conn = null;
      }

      if (this.childProcess) {
        // Make sure to forcefully kill the browser process
        this.childProcess.kill('SIGKILL');
        this.childProcess = null;
      }

      if (this.userDataDir) {
        try {
          // Improved recursive deletion
          rimraf.sync(this.userDataDir);
        } catch (err) {
          console.error(`Error removing user data directory: ${err}`);
        }
      }

      console.log('Browser closed successfully.');
    } catch (error) {
      console.error(`Error during browser closure: ${error}`);
      throw error;
    }
  }

  /**
   * Get WebSocket endpoint URL
   * @returns {string} - The WebSocket endpoint URL
   */
  getWSEndpoint() {
    return this.wsEndpoint;
  }

  /**
   * Checks if browser is connected
   * @returns {boolean} - Whether browser is connected
   */
  isConnected() {
    return !!(this.conn && this.conn.readyState === WebSocket.OPEN);
  }

  /**
   * Get version information
   * @returns {Promise<Object>} - Version info
   */
  async version() {
    try {
      const response = await this.sendCommand('Browser.getVersion');
      return response.result;
    } catch (error) {
      console.error(`Failed to get version: ${error}`);
      throw error;
    }
  }
}

/**
 * BrowserContext class for managing contexts (similar to Playwright)
 */
class BrowserContext {
  /**
   * Create a new browser context
   * @param {Browser} browser - Browser instance
   */
  constructor(browser) {
    this.browser = browser;
    this.pages = new Set();
    this.isDefault = false;
    this._firstPageCreated = false;
  }

  /**
   * Create a new page in this context or return the initial page on first call
   * @returns {Promise<Page>} - Created or existing page
   */
  async newPage() {
    try {
      // If this is the first call to newPage() and we have an initial target ID,
      // return the existing page instead of creating a new one
      if (!this._firstPageCreated && this.browser.initialTargetId) {
        this._firstPageCreated = true;
        
        // Get existing targets
        const { result } = await this.browser.sendCommand('Target.getTargets');
        
        if (result && result.targetInfos) {
          // Find our initial page target
          const initialTarget = result.targetInfos.find(t => 
            t.targetId === this.browser.initialTargetId && t.type === 'page'
          );
          
          if (initialTarget) {
            // Create a new Page object for the existing page
            const page = new Page(this.browser);
            page._targetId = initialTarget.targetId;
            this.pages.add(page);
            
            console.log(`Using existing page: ${initialTarget.url}`);
            return page;
          }
        }
      }
      
      // Create a new page if needed
      console.log("Creating new page...");
      const { result } = await this.browser.sendCommand('Target.createTarget', {
        url: 'about:blank'
      });

      if (!result || !result.targetId) {
        throw new Error('Failed to create new page');
      }

      // Switch to the new target
      const { result: attachInfo } = await this.browser.sendCommand('Target.attachToTarget', {
        targetId: result.targetId,
        flatten: true
      });

      if (!attachInfo || !attachInfo.sessionId) {
        throw new Error('Failed to attach to new page');
      }

      // Create a new Page object
      const page = new Page(this.browser);
      page._targetId = result.targetId;
      this.pages.add(page);

      return page;
    } catch (error) {
      console.error(`Failed to create new page: ${error}`);
      throw error;
    }
  }

  /**
   * Close this browser context
   * @returns {Promise<void>}
   */
  async close() {
    try {
      // Close all pages in this context
      for (const page of this.pages) {
        await page.close();
      }
      this.pages.clear();

      // Remove this context from browser's contexts set
      if (!this.isDefault) {
        this.browser.contexts.delete(this);
      }
    } catch (error) {
      console.error(`Failed to close browser context: ${error}`);
      throw error;
    }
  }

  /**
   * Get all pages in this context
   * @returns {Promise<Array<Page>>} - Array of pages
   */
  async pages() {
    return Array.from(this.pages);
  }
}

/**
 * StealthWright class for managing browser instances
 */
class StealthWright {
  /**
   * Create a new StealthWright instance
   * @param {Object} options - StealthWright options
   */
  constructor(options = {}) {
    this.options = options;
    this.browser = null;
  }

  /**
   * Launch a new browser instance
   * @param {Object} options - Launch options
   * @returns {Promise<Browser>} - Browser instance
   */
  async launch(options = {}) {
    try {
      const mergedOptions = { ...this.options, ...options };
      
      // Find Chrome executable path
      let execPath = mergedOptions.execPath;
      
      // If not provided directly, try to detect
      if (!execPath) {
        execPath = getChromePath();
      }

      if (!execPath) {
        throw new errors.BrowserLaunchError('Chrome executable not found. Please provide execPath in options.');
      }

      console.log(`Using browser executable: ${execPath}`);
      
      // Create and launch browser
      this.browser = new Browser(execPath, mergedOptions);
      await this.browser.launch(mergedOptions);

      return this.browser;
    } catch (error) {
      console.error(`Failed to launch browser: ${error}`);
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      throw error;
    }
  }

  /**
   * Connect to an existing browser instance via WebSocket endpoint
   * @param {Object} options - Connection options
   * @param {string} options.wsEndpoint - WebSocket endpoint URL
   * @returns {Promise<Browser>} - Connected browser instance
   */
  async connect(options) {
    try {
      if (!options.wsEndpoint) {
        throw new Error('WebSocket endpoint URL is required');
      }

      this.browser = new Browser(null, this.options);
      this.browser.wsEndpoint = options.wsEndpoint;
      
      // Connect directly via WebSocket
      this.browser.conn = new WebSocket(options.wsEndpoint);
      
      await new Promise((resolve, reject) => {
        this.browser.conn.on('open', resolve);
        this.browser.conn.on('error', reject);
      });
      
      this.browser.setupMessageHandling();
      
      // Create a default browser context
      this.browser.defaultContext = await this.browser.createBrowserContext();
      
      return this.browser;
    } catch (error) {
      console.error(`Failed to connect to browser: ${error}`);
      throw error;
    }
  }

  /**
   * Close all browsers and resources
   * @returns {Promise<void>}
   */
  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

module.exports = {
  StealthWright,
  Browser,
  BrowserContext,
  getRandomProxy,
  parseProxyUrl
};
