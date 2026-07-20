const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ===== USE STEALTH PLUGIN =====
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

// ===== FIX: Download Chrome at startup (Render.com Linux environment only) =====
const isLinux = process.platform === 'linux';
const CHROME_CACHE_DIR = isLinux ? '/opt/render/.cache/puppeteer' : path.join(__dirname, '.cache/puppeteer');

let CHROME_PATH = '';
if (isLinux) {
    const findChrome = (dir) => {
        if (!fs.existsSync(dir)) return null;
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            if (fs.statSync(fullPath).isDirectory()) {
                const found = findChrome(fullPath);
                if (found) return found;
            } else if (file === 'chrome' && !fullPath.includes('chrome-wrapper')) {
                return fullPath;
            }
        }
        return null;
    };

    CHROME_PATH = findChrome(CHROME_CACHE_DIR) || '';
}

if (isLinux) {
    console.log(`[${new Date().toISOString()}] Initial check: Chrome at: ${CHROME_PATH}`);

    if (!CHROME_PATH || !fs.existsSync(CHROME_PATH)) {
        console.log(`[${new Date().toISOString()}] Chrome not found, downloading...`);
        if (!fs.existsSync(CHROME_CACHE_DIR)) {
            fs.mkdirSync(CHROME_CACHE_DIR, { recursive: true });
        }
        try {
            console.log(`[${new Date().toISOString()}] Running: npx puppeteer browsers install chrome`);
            execSync('npx puppeteer browsers install chrome', {
                cwd: __dirname,
                stdio: 'inherit',
                env: { ...process.env, PUPPETEER_CACHE_DIR: CHROME_CACHE_DIR }
            });
            console.log(`[${new Date().toISOString()}] Chrome installed successfully`);
            CHROME_PATH = findChrome(CHROME_CACHE_DIR) || '';
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Failed to install Chrome:`, error.message);
        }
    }

    if (CHROME_PATH && fs.existsSync(CHROME_PATH)) {
        console.log(`[${new Date().toISOString()}] ✅ Chrome found at: ${CHROME_PATH}`);
    } else {
        console.log(`[${new Date().toISOString()}] ⚠️ Chrome still not found, will try puppeteer default`);
    }
} else {
    console.log(`[${new Date().toISOString()}] Running on non-Linux platform (${process.platform}). Letting Puppeteer resolve standard local Chrome executable.`);
}

// Rate limiting
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: 'Too many requests, please try again later.' }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(limiter);

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'puppeteer-3ds-api',
        chrome_exists: fs.existsSync(CHROME_PATH),
        chrome_path: CHROME_PATH
    });
});

// ===== HCAPTCHA SOLVING ENDPOINT =====
app.post('/api/solve-hcaptcha', async (req, res) => {
    const startTime = Date.now();
    let browser = null;

    try {
        const {
            sitekey = 'c7faac4c-1cd7-4b1b-b2d4-42ba98d09c7a',
            rqdata = null,
            proxy = null,
            timeout = 45000,
            userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        } = req.body;

        console.log(`[${new Date().toISOString()}] === HCAPTCHA SOLVER REQUEST ===`);
        console.log(`[${new Date().toISOString()}] SiteKey: ${sitekey}`);

        if (!rqdata) {
            return res.status(400).json({ error: 'rqdata is required' });
        }

        const launchOptions = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=BlockInsecurePrivateNetworkRequests',
                '--disable-site-isolation-trials'
            ],
            timeout: timeout
        };

        if (proxy) {
            try {
                let parsedProxy = proxy.trim();
                const parts = parsedProxy.split(':');
                if (parts.length >= 2) {
                    const host = parts[0];
                    const port = parts[1];
                    launchOptions.args.push(`--proxy-server=http://${host}:${port}`);
                }
            } catch (e) {
                console.log('Proxy setup error:', e.message);
            }
        }

        if (CHROME_PATH && fs.existsSync(CHROME_PATH)) {
            launchOptions.executablePath = CHROME_PATH;
        }

        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();

        // Disable Content Security Policy to allow external script injection
        await page.setBypassCSP(true);
        
        // Log errors/messages from the browser window safely
        page.on('console', msg => {
            try {
                const text = msg.text();
                if (text) console.log(`[Browser Console] ${text}`);
            } catch (e) {}
        });
        page.on('pageerror', err => {
            try {
                const msg = err.message || err;
                if (msg) console.log(`[Browser Page Error] ${msg}`);
            } catch (e) {}
        });

        await page.setUserAgent(userAgent);
        await page.setViewport({ width: 1366, height: 768 });

        // Speed Optimization: Block heavy non-hcaptcha assets & mock stripe checkout origin
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const url = req.url();
            const resourceType = req.resourceType();
            
            if (url.includes('checkout.stripe.com/captcha-test')) {
                req.respond({
                    status: 200,
                    contentType: 'text/html',
                    body: '<!DOCTYPE html><html><head><title>Stripe Challenge</title></head><body><div id="hcaptcha-container" style="display: flex; justify-content: center; align-items: center; height: 100vh;"></div></body></html>'
                });
            } else if (['image', 'stylesheet', 'font', 'media'].includes(resourceType) && !url.includes('hcaptcha.com')) {
                req.abort();
            } else {
                req.continue();
            }
        });
        
        if (proxy) {
            try {
                let parsedProxy = proxy.trim();
                const parts = parsedProxy.split(':');
                if (parts.length >= 4) {
                    await page.authenticate({
                        username: decodeURIComponent(parts[2]),
                        password: decodeURIComponent(parts[3])
                    });
                }
            } catch (e) { }
        }
        
        console.log(`[${new Date().toISOString()}] Loading domain origin...`);
        await page.goto('https://checkout.stripe.com/captcha-test', { waitUntil: 'domcontentloaded', timeout: timeout });
            
        console.log(`[${new Date().toISOString()}] Injecting hCaptcha container and rendering...`);
        await page.evaluate((key, data) => {
            document.body.innerHTML = '<div id="hcaptcha-container" style="display: flex; justify-content: center; align-items: center; height: 100vh;"></div>';
            
            return new Promise((resolve, reject) => {
                window.onHCaptchaLoaded = () => {
                    try {
                        if (window.hcaptcha && window.hcaptcha.render) {
                            window.hcaptcha.render('hcaptcha-container', {
                                sitekey: key,
                                rqdata: data,
                                callback: (token) => {
                                    window.solvedToken = token;
                                },
                                'error-callback': (err) => {
                                    window.solvedError = err || 'hcaptcha error';
                                }
                            });
                            resolve();
                        } else {
                            reject('hcaptcha object unavailable after load');
                        }
                    } catch (e) {
                        reject(e.message);
                    }
                };

                const script = document.createElement('script');
                script.src = 'https://js.hcaptcha.com/1/api.js?onload=onHCaptchaLoaded&render=explicit&recaptchacompat=off';
                script.async = true;
                script.defer = true;
                script.onerror = () => reject('Failed to load hCaptcha script');
                document.head.appendChild(script);
            });
        }, sitekey, rqdata);

        console.log(`[${new Date().toISOString()}] Waiting for hCaptcha checkbox frame...`);
        const checkboxClicked = async () => {
            const frames = page.frames();
            for (const frame of frames) {
                const url = frame.url();
                if (url.includes('hcaptcha.com') || url.includes('assets.hcaptcha.com')) {
                    try {
                        const checkbox = await frame.waitForSelector('#checkbox, #anchor, .check, [aria-checked]', { timeout: 1000 }).catch(() => null);
                        if (checkbox) {
                            await frame.evaluate(() => {
                                const el = document.querySelector('#checkbox, #anchor, .check, [aria-checked]');
                                if (el) el.click();
                            }).catch(() => {});
                            await checkbox.click({ delay: 50 }).catch(() => {});
                            console.log(`[${new Date().toISOString()}] Clicked hCaptcha checkbox`);
                            return true;
                        }
                    } catch (e) {}
                }
            }
            return false;
        };

        let clicked = false;
        for (let i = 0; i < 15; i++) {
            clicked = await checkboxClicked();
            if (clicked) break;
            await new Promise(r => setTimeout(r, 1000));
        }

        console.log(`[${new Date().toISOString()}] Polling for solved hCaptcha token...`);
        let token = null;
        let isChallengeRequired = false;
        
        for (let i = 0; i < 7; i++) {
            token = await page.evaluate(() => window.solvedToken);
            if (token) break;

            const err = await page.evaluate(() => window.solvedError);
            if (err) throw new Error(err);
            
            const challengeVisible = await page.evaluate(() => {
                const iframes = Array.from(document.querySelectorAll('iframe'));
                for (const f of iframes) {
                    const title = (f.getAttribute('title') || '').toLowerCase();
                    const src = (f.getAttribute('src') || '').toLowerCase();
                    if (src.includes('hcaptcha.com') && title.includes('challenge') && !title.includes('widget') && !title.includes('checkbox')) {
                        const style = window.getComputedStyle(f);
                        if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                            return true;
                        }
                    }
                }
                return false;
            });
            
            if (challengeVisible) {
                console.log(`[${new Date().toISOString()}] hCaptcha image/puzzle challenge box detected`);
                isChallengeRequired = true;
                break;
            }

            await new Promise(r => setTimeout(r, 1000));
        }

        if (token) {
            console.log(`[${new Date().toISOString()}] ✅ hCaptcha Solved successfully! Time: ${Date.now() - startTime}ms`);
            return res.json({ success: true, token });
        } else if (isChallengeRequired) {
            console.log(`[${new Date().toISOString()}] ⚠️ hCaptcha requires manual verification. Returning challenge_required`);
            return res.json({ success: false, error: 'challenge_required' });
        } else {
            throw new Error('Verification timed out or failed');
        }

    } catch (error) {
        console.error(`[${new Date().toISOString()}] hCaptcha solver error:`, error.message);
        return res.status(500).json({ success: false, error: error.message });
    } finally {
        if (browser) {
            try {
                const pages = await browser.pages();
                await Promise.all(pages.map(p => p.close().catch(() => {})));
                await browser.close();
            } catch (e) {}
        }
    }
});

// ===== MAIN 3DS AUTOMATION ENDPOINT =====
app.post('/api/3ds-automate', async (req, res) => {
    const startTime = Date.now();
    let browser = null;

    try {
        const {
            url,
            proxy = null,
            timeout = 60000,
            userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            waitFor3DS = true,
            screenshot = false,
            autoSubmit = true,
            viewport = { width: 1366, height: 768 }
        } = req.body;

        console.log(`[${new Date().toISOString()}] === NEW REQUEST ===`);
        console.log(`[${new Date().toISOString()}] URL: ${url ? url.substring(0, 100) : 'NO URL'}`);

        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        const chromeExists = fs.existsSync(CHROME_PATH);
        console.log(`[${new Date().toISOString()}] Chrome exists: ${chromeExists}`);

        const launchOptions = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-blink-features=AutomationControlled',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-ipc-flooding-protection',
                '--disable-hang-monitor',
                '--disable-prompt-on-repost',
                '--disable-sync',
                '--disable-translate',
                '--disable-default-apps',
                '--disable-extensions',
                '--disable-plugins',
                '--disable-infobars',
                '--disable-notifications',
                '--disable-popup-blocking',
                '--disable-component-extensions-with-background-pages',
                '--no-first-run',
                '--force-color-profile=srgb',
                '--metrics-recording-only',
                '--password-store=basic',
                '--use-mock-keychain',
                '--single-process',
                '--disable-accelerated-2d-canvas',
                '--disable-accelerated-jpeg-decoding',
                '--disable-accelerated-mjpeg-decode',
                '--disable-accelerated-video-decode',
                '--disable-accelerated-video-encode',
                '--disable-features=BlockInsecurePrivateNetworkRequests',
                '--disable-features=IsolateOrigins',
                '--disable-site-isolation-trials',
                '--disable-features=BlockInsecurePrivateNetworkRequests',
                '--disable-web-resource'
            ],
            timeout: timeout
        };

        if (proxy) {
            try {
                let parsedProxy = proxy.trim();
                const parts = parsedProxy.split(':');
                if (parts.length >= 2) {
                    const host = parts[0];
                    const port = parts[1];
                    launchOptions.args.push(`--proxy-server=http://${host}:${port}`);
                    console.log(`[${new Date().toISOString()}] Added browser proxy server arg: http://${host}:${port}`);
                } else {
                    if (!parsedProxy.startsWith('http://') && !parsedProxy.startsWith('https://')) {
                        parsedProxy = 'http://' + parsedProxy;
                    }
                    const proxyUrl = new URL(parsedProxy);
                    launchOptions.args.push(`--proxy-server=http://${proxyUrl.host}`);
                    console.log(`[${new Date().toISOString()}] Added browser proxy server arg: http://${proxyUrl.host}`);
                }
            } catch (e) {
                console.log('Proxy launch arg config error:', e.message);
            }
        }

        if (chromeExists) {
            launchOptions.executablePath = CHROME_PATH;
            console.log(`[${new Date().toISOString()}] Using Chrome at: ${CHROME_PATH}`);
        } else {
            console.log(`[${new Date().toISOString()}] Chrome not found, letting puppeteer find it`);
        }

        browser = await puppeteer.launch(launchOptions);
        console.log(`[${new Date().toISOString()}] Browser launched successfully`);

        const page = await browser.newPage();
        console.log(`[${new Date().toISOString()}] New page created`);

        await page.setUserAgent(userAgent);
        await page.setViewport(viewport);
        console.log(`[${new Date().toISOString()}] User agent and viewport set`);

        if (proxy) {
            try {
                let parsedProxy = proxy.trim();
                const parts = parsedProxy.split(':');
                if (parts.length >= 4) {
                    const host = parts[0];
                    const port = parts[1];
                    const user = parts[2];
                    const pass = parts[3];
                    console.log(`[${new Date().toISOString()}] Configured proxy authentication for credentials: ${user}:******`);
                    await page.authenticate({
                        username: decodeURIComponent(user),
                        password: decodeURIComponent(pass)
                    });
                } else {
                    if (!parsedProxy.startsWith('http://') && !parsedProxy.startsWith('https://')) {
                        parsedProxy = 'http://' + parsedProxy;
                    }
                    const proxyUrl = new URL(parsedProxy);
                    if (proxyUrl.username && proxyUrl.password) {
                        console.log(`[${new Date().toISOString()}] Configured proxy credentials from URL: ${proxyUrl.username}:******`);
                        await page.authenticate({
                            username: decodeURIComponent(proxyUrl.username),
                            password: decodeURIComponent(proxyUrl.password)
                        });
                    }
                }
                console.log(`[${new Date().toISOString()}] Proxy authentication registered`);
            } catch (e) {
                console.log('Proxy authentication config warning:', e.message);
            }
        }

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

            window.chrome = {
                app: {
                    isInstalled: false,
                    InstallState: {
                        DISABLED: 'disabled',
                        INSTALLED: 'installed',
                        NOT_INSTALLED: 'not_installed'
                    },
                    RunningState: {
                        CANNOT_RUN: 'cannot_run',
                        READY_TO_RUN: 'ready_to_run',
                        RUNNING: 'running'
                    }
                },
                runtime: {
                    OnInstalledReason: {
                        CHROME_UPDATE: 'chrome_update',
                        INSTALL: 'install',
                        SHARED_MODULE_UPDATE: 'shared_module_update',
                        UPDATE: 'update'
                    },
                    OnRestartRequiredReason: {
                        APP_UPDATE: 'app_update',
                        OS_UPDATE: 'os_update',
                        PERIODIC: 'periodic'
                    },
                    PlatformArch: {
                        ARM: 'arm',
                        ARM64: 'arm64',
                        MIPS: 'mips',
                        MIPS64: 'mips64',
                        X86_32: 'x86-32',
                        X86_64: 'x86-64'
                    },
                    PlatformNaclArch: {
                        ARM: 'arm',
                        MIPS: 'mips',
                        MIPS64: 'mips64',
                        X86_32: 'x86-32',
                        X86_64: 'x86-64'
                    },
                    PlatformOs: {
                        ANDROID: 'android',
                        CROS: 'cros',
                        LINUX: 'linux',
                        MAC: 'mac',
                        OPENBSD: 'openbsd',
                        WIN: 'win'
                    },
                    RequestUpdateCheckStatus: {
                        NO_UPDATE: 'no_update',
                        THROTTLED: 'throttled',
                        UPDATE_AVAILABLE: 'update_available'
                    },
                    connect: () => { },
                    sendMessage: () => { }
                },
                loadTimes: function () { },
                csi: function () { }
            };

            const mockPlugins = [
                { name: 'PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
                { name: 'Chrome PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
                { name: 'Chromium PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
                { name: 'Microsoft Edge PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
                { name: 'WebKit built-in PDF', description: 'Portable Document Format', filename: 'internal-pdf-viewer' }
            ];

            Object.defineProperty(navigator, 'plugins', {
                get: () => {
                    const plugins = [...mockPlugins];
                    plugins.item = function (i) { return this[i] || null; };
                    plugins.namedItem = function (n) {
                        return this.find(p => p.name === n) || null;
                    };
                    plugins.refresh = function () { };
                    return plugins;
                }
            });

            Object.defineProperty(navigator, 'mimeTypes', {
                get: () => {
                    const mimeTypes = [
                        { type: 'application/pdf', description: 'Portable Document Format', suffixes: 'pdf', enabledPlugin: mockPlugins[0] },
                        { type: 'text/pdf', description: 'Portable Document Format', suffixes: 'pdf', enabledPlugin: mockPlugins[0] }
                    ];
                    mimeTypes.item = function (i) { return this[i] || null; };
                    mimeTypes.namedItem = function (n) {
                        return this.find(m => m.type === n) || null;
                    };
                    return mimeTypes;
                }
            });

            const getParameter = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (type, attributes) {
                const ctx = getParameter.apply(this, arguments);
                if (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2') {
                    const origGetParameter = ctx.getParameter;
                    ctx.getParameter = function (parameter) {
                        if (parameter === 37445) return 'Google Inc. (NVIDIA)';
                        if (parameter === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
                        if (parameter === 7936) return 'WebKit';
                        if (parameter === 7937) return 'WebKit WebGL';
                        return origGetParameter.apply(this, arguments);
                    };
                }
                return ctx;
            };

            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en']
            });

            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
            );

            if (window.callPhantom) delete window.callPhantom;
            if (window._phantom) delete window._phantom;

            Object.defineProperty(navigator, 'connection', {
                get: () => ({
                    effectiveType: '4g',
                    rtt: 50,
                    downlink: 10,
                    saveData: false
                })
            });

            Object.defineProperty(navigator, 'hardwareConcurrency', {
                get: () => 8
            });

            Object.defineProperty(navigator, 'deviceMemory', {
                get: () => 8
            });

            Object.defineProperty(navigator, 'platform', {
                get: () => 'Win32'
            });

            Object.defineProperty(window.screen, 'availWidth', { get: () => 1920 });
            Object.defineProperty(window.screen, 'availHeight', { get: () => 1080 });
            Object.defineProperty(window.screen, 'width', { get: () => 1920 });
            Object.defineProperty(window.screen, 'height', { get: () => 1080 });
        });

        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'Cache-Control': 'max-age=0'
        });

        console.log(`[${new Date().toISOString()}] Navigating to URL...`);
        try {
            await page.goto(url, {
                waitUntil: 'networkidle2',
                timeout: timeout
            });
        } catch (navError) {
            console.log(`[${new Date().toISOString()}] Navigation warning: ${navError.message}`);
            try {
                await page.waitForSelector('body', { timeout: 5000 });
            } catch (bodyError) {
                throw new Error('Page navigation failed: ' + navError.message);
            }
        }

        console.log(`[${new Date().toISOString()}] Page loaded. Current URL: ${page.url()}`);

        if (autoSubmit) {
            console.log(`[${new Date().toISOString()}] Looking for submit buttons...`);
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 2000));
                    const buttons = await page.$$(
                        'button[type="submit"], input[type="submit"], ' +
                        '.btn-primary, .continue-btn, .submit-btn, .btn-continue, ' +
                        'button[role="button"], .btn:not([type="button"])'
                    );
                    for (const button of buttons) {
                        try {
                            const visible = await button.isVisible();
                            const enabled = await button.isEnabled();
                            if (visible && enabled) {
                                await button.click();
                                console.log(`[${new Date().toISOString()}] Clicked submit button (attempt ${attempt + 1})`);
                                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => { });
                                break;
                            }
                        } catch (e) { }
                    }
                } catch (e) {
                    console.log(`[${new Date().toISOString()}] Auto-submit attempt ${attempt + 1} failed`);
                }
            }
        }

        if (waitFor3DS) {
            console.log(`[${new Date().toISOString()}] Waiting for 3DS completion...`);
            let completed = false;
            let attempts = 0;
            const maxAttempts = 90;

            const trySolveCaptcha = async () => {
                const frames = page.frames();
                for (const frame of frames) {
                    const frameUrl = frame.url();
                    if (frameUrl.includes('challenges.cloudflare.com')) {
                        console.log('Turnstile challenge detected in iframe');
                        try {
                            const checkbox = await frame.waitForSelector('#challenge-stage, .ctp-checkbox-label, input[type="checkbox"], #challenge-stage input', { timeout: 1000 }).catch(() => null);
                            if (checkbox) {
                                console.log('Clicking Turnstile checkbox...');
                                await frame.evaluate(() => {
                                    const el = document.querySelector('#challenge-stage, .ctp-checkbox-label, input[type="checkbox"], #challenge-stage input');
                                    if (el) el.click();
                                }).catch(() => {});
                                await checkbox.click({ delay: 50 }).catch(() => {});
                                await new Promise(resolve => setTimeout(resolve, 3000));
                                return true;
                            }
                        } catch (e) {}
                    }
                    if (frameUrl.includes('hcaptcha.com') || frameUrl.includes('assets.hcaptcha.com')) {
                        console.log('hCaptcha detected in iframe');
                        try {
                            const checkbox = await frame.waitForSelector('#checkbox, #anchor, .check, [aria-checked]', { timeout: 1000 }).catch(() => null);
                            if (checkbox) {
                                console.log('Clicking hCaptcha checkbox...');
                                await frame.evaluate(() => {
                                    const el = document.querySelector('#checkbox, #anchor, .check, [aria-checked]');
                                    if (el) el.click();
                                }).catch(() => {});
                                await checkbox.click({ delay: 50 }).catch(() => {});
                                await new Promise(resolve => setTimeout(resolve, 3000));
                                return true;
                            }
                        } catch (e) {}
                    }
                }
                return false;
            };

            while (!completed && attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                attempts++;

                try {
                    const currentUrl = page.url();

                    if (currentUrl.includes('checkout.stripe.com/return') ||
                        currentUrl.includes('hooks.stripe.com') ||
                        currentUrl.includes('payment_intent') ||
                        currentUrl.includes('succeeded') ||
                        currentUrl.includes('success_url') ||
                        currentUrl.includes('redirect_status=succeeded')) {
                        completed = true;
                        console.log(`[${new Date().toISOString()}] ✅ 3DS completed at: ${currentUrl}`);
                        break;
                    }

                    await trySolveCaptcha();

                    const pageContent = await page.content();
                    if (pageContent.includes('error') || pageContent.includes('declined') ||
                        pageContent.includes('failed') || pageContent.includes('authentication_failure')) {
                        console.log(`[${new Date().toISOString()}] ❌ Error detected`);
                        break;
                    }

                    if (attempts % 5 === 0) {
                        try {
                            const dynamicButtons = await page.$$(
                                'button[type="submit"], input[type="submit"], .btn-primary, .continue-btn'
                            );
                            for (const button of dynamicButtons) {
                                if (await button.isVisible() && await button.isEnabled()) {
                                    await button.click();
                                    console.log(`[${new Date().toISOString()}] Clicked dynamic button`);
                                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => { });
                                    break;
                                }
                            }
                        } catch (e) { }
                    }

                    if (attempts % 10 === 0) {
                        console.log(`[${new Date().toISOString()}] Waiting... ${attempts}s/${maxAttempts}s`);
                        console.log(`[${new Date().toISOString()}] Current URL: ${currentUrl.substring(0, 100)}...`);
                    }
                } catch (e) {
                    console.error('Polling error:', e.message);
                }
            }
        }

        console.log(`[${new Date().toISOString()}] Collecting results...`);
        const finalUrl = await page.url();
        const finalTitle = await page.title();
        const finalContent = await page.content();
        const finalCookies = await page.cookies();

        let screenshotData = null;
        if (screenshot) {
            screenshotData = await page.screenshot({
                encoding: 'base64',
                fullPage: true,
                type: 'png'
            });
            console.log(`[${new Date().toISOString()}] Screenshot captured`);
        }

        const urlParams = new URLSearchParams(new URL(finalUrl).search);
        const params = {};
        for (const [key, value] of urlParams) {
            params[key] = value;
        }

        await browser.close();
        console.log(`[${new Date().toISOString()}] Browser closed`);

        const result = {
            success: true,
            completed: true,
            url: finalUrl,
            title: finalTitle,
            cookies: finalCookies,
            params: params,
            screenshot: screenshotData || null,
            html: finalContent,
            source: params.source || null,
            payment_intent: params.payment_intent || null,
            redirect_status: params.redirect_status || null,
            client_secret: params.client_secret || null,
            processing_time: Date.now() - startTime
        };

        console.log(`[${new Date().toISOString()}] ✅ Success! Time: ${result.processing_time}ms`);
        res.json(result);

    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ ERROR:`, error.message);
        console.error(`[${new Date().toISOString()}] Stack:`, error.stack);

        if (browser) {
            try {
                await browser.close();
                console.log(`[${new Date().toISOString()}] Browser closed after error`);
            } catch (e) {
                console.log(`[${new Date().toISOString()}] Error closing browser: ${e.message}`);
            }
        }

        res.status(500).json({
            success: false,
            error: error.message,
            processing_time: Date.now() - startTime
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`✅ Puppeteer 3DS API Server running on port ${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   API endpoint: http://localhost:${PORT}/api/3ds-automate`);
});
