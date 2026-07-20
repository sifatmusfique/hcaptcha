const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { hcaptcha, hcaptchaToken } = require('puppeteer-hcaptcha');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ===== USE STEALTH PLUGIN =====
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Chrome detection for Render.com Linux =====
const isLinux = process.platform === 'linux';
const CHROME_CACHE_DIR = isLinux
    ? '/opt/render/.cache/puppeteer'
    : path.join(__dirname, '.cache/puppeteer');

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

let CHROME_PATH = isLinux ? (findChrome(CHROME_CACHE_DIR) || '') : '';

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
    console.log(`[${new Date().toISOString()}] Non-Linux platform (${process.platform}). Using Puppeteer default Chrome.`);
}

// ===== Rate limiting =====
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: 'Too many requests, please try again later.' }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(limiter);

// ===== Health check =====
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'hcaptcha-solver-api',
        chrome_exists: CHROME_PATH ? fs.existsSync(CHROME_PATH) : false,
        chrome_path: CHROME_PATH || 'puppeteer default'
    });
});

// ===== Helper: Build launch options =====
function buildLaunchOptions(proxy, timeout) {
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=BlockInsecurePrivateNetworkRequests',
        '--disable-site-isolation-trials'
    ];

    if (proxy) {
        try {
            const parts = proxy.trim().split(':');
            if (parts.length >= 2) {
                args.push(`--proxy-server=http://${parts[0]}:${parts[1]}`);
            }
        } catch (e) {
            console.log(`[${new Date().toISOString()}] Proxy arg error:`, e.message);
        }
    }

    const opts = { headless: true, args, timeout };
    if (CHROME_PATH && fs.existsSync(CHROME_PATH)) {
        opts.executablePath = CHROME_PATH;
    }
    return opts;
}

// ===== Helper: Set proxy auth on page =====
async function setProxyAuth(page, proxy) {
    if (!proxy) return;
    try {
        const parts = proxy.trim().split(':');
        if (parts.length >= 4) {
            await page.authenticate({
                username: decodeURIComponent(parts[2]),
                password: decodeURIComponent(parts[3])
            });
        } else {
            let parsed = proxy.trim();
            if (!parsed.startsWith('http://') && !parsed.startsWith('https://')) {
                parsed = 'http://' + parsed;
            }
            const u = new URL(parsed);
            if (u.username && u.password) {
                await page.authenticate({
                    username: decodeURIComponent(u.username),
                    password: decodeURIComponent(u.password)
                });
            }
        }
    } catch (e) {
        console.log(`[${new Date().toISOString()}] Proxy auth warning:`, e.message);
    }
}

// ===== HCAPTCHA SOLVING ENDPOINT =====
// Uses puppeteer-hcaptcha library to solve hcaptcha tokens
app.post('/api/solve-hcaptcha', async (req, res) => {
    const startTime = Date.now();
    let browser = null;

    try {
        const {
            sitekey = 'c7faac4c-1cd7-4b1b-b2d4-42ba98d09c7a',
            url: pageUrl = 'https://accounts.hcaptcha.com/demo',
            rqdata = null,
            proxy = null,
            timeout = 120000,
            userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        } = req.body;

        console.log(`[${new Date().toISOString()}] === HCAPTCHA SOLVER REQUEST ===`);
        console.log(`[${new Date().toISOString()}] SiteKey: ${sitekey}`);
        console.log(`[${new Date().toISOString()}] Page URL: ${pageUrl}`);

        // hcaptchaToken solves directly without needing a full browser session on the page
        console.log(`[${new Date().toISOString()}] Solving via puppeteer-hcaptcha (hcaptchaToken)...`);
        let token = null;

        try {
            token = await hcaptchaToken(`${sitekey}:${pageUrl}`);
        } catch (libErr) {
            console.log(`[${new Date().toISOString()}] hcaptchaToken failed, trying browser approach:`, libErr.message);
        }

        // Fallback: use browser-based solving with puppeteer-hcaptcha's hcaptcha(page)
        if (!token) {
            console.log(`[${new Date().toISOString()}] Falling back to browser-based hcaptcha(page)...`);

            const launchOptions = buildLaunchOptions(proxy, timeout);
            browser = await puppeteer.launch(launchOptions);
            const page = await browser.newPage();

            try {
                await page.setUserAgent(userAgent);
                await page.setViewport({ width: 1366, height: 768 });
                await setProxyAuth(page, proxy);

                // Navigate to the target page where hcaptcha is embedded
                await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout }).catch(() => {});

                // Let puppeteer-hcaptcha solve the hcaptcha on the page
                await hcaptcha(page);

                // Extract the token from the response textarea
                token = await page.evaluate(() => {
                    const el = document.querySelector('[name="h-captcha-response"], textarea[name="g-recaptcha-response"]');
                    return el ? el.value : null;
                });

                if (!token) {
                    // Try window.solvedToken if it was set
                    token = await page.evaluate(() => window.hcaptchaToken || null);
                }
            } finally {
                const pages = await browser.pages().catch(() => []);
                await Promise.all(pages.map(p => p.close().catch(() => {})));
                await browser.close().catch(() => {});
                browser = null;
            }
        }

        if (token) {
            console.log(`[${new Date().toISOString()}] ✅ hCaptcha Solved! Token length: ${token.length}, Time: ${Date.now() - startTime}ms`);
            return res.json({ success: true, token, time: Date.now() - startTime });
        } else {
            return res.json({ success: false, error: 'challenge_required', message: 'Could not solve hCaptcha automatically. Manual challenge required.' });
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

        console.log(`[${new Date().toISOString()}] === NEW 3DS REQUEST ===`);
        console.log(`[${new Date().toISOString()}] URL: ${url ? url.substring(0, 100) : 'NO URL'}`);

        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
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
                '--disable-features=BlockInsecurePrivateNetworkRequests',
                '--disable-site-isolation-trials',
                '--disable-web-resource'
            ],
            timeout
        };

        if (proxy) {
            try {
                const parts = proxy.trim().split(':');
                if (parts.length >= 2) {
                    launchOptions.args.push(`--proxy-server=http://${parts[0]}:${parts[1]}`);
                }
            } catch (e) {
                console.log('Proxy launch arg error:', e.message);
            }
        }

        if (CHROME_PATH && fs.existsSync(CHROME_PATH)) {
            launchOptions.executablePath = CHROME_PATH;
            console.log(`[${new Date().toISOString()}] Using Chrome at: ${CHROME_PATH}`);
        }

        browser = await puppeteer.launch(launchOptions);
        console.log(`[${new Date().toISOString()}] Browser launched`);

        const page = await browser.newPage();
        await page.setUserAgent(userAgent);
        await page.setViewport(viewport);
        await setProxyAuth(page, proxy);

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
            Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
            window.chrome = { runtime: { connect: () => {}, sendMessage: () => {} } };
        });

        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Upgrade-Insecure-Requests': '1',
            'Cache-Control': 'max-age=0'
        });

        console.log(`[${new Date().toISOString()}] Navigating to URL...`);
        try {
            await page.goto(url, { waitUntil: 'networkidle2', timeout });
        } catch (navError) {
            console.log(`[${new Date().toISOString()}] Navigation warning: ${navError.message}`);
            await page.waitForSelector('body', { timeout: 5000 }).catch(() => {
                throw new Error('Page navigation failed: ' + navError.message);
            });
        }

        console.log(`[${new Date().toISOString()}] Page loaded. URL: ${page.url()}`);

        // Auto-submit forms
        if (autoSubmit) {
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    if (attempt > 0) await new Promise(r => setTimeout(r, 2000));
                    const buttons = await page.$$('button[type="submit"], input[type="submit"], .btn-primary, .continue-btn');
                    for (const button of buttons) {
                        if (await button.isVisible() && await button.isEnabled()) {
                            await button.click();
                            console.log(`[${new Date().toISOString()}] Clicked submit (attempt ${attempt + 1})`);
                            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => {});
                            break;
                        }
                    }
                } catch (e) {}
            }
        }

        // Wait for 3DS + handle captchas
        if (waitFor3DS) {
            console.log(`[${new Date().toISOString()}] Waiting for 3DS completion...`);
            let completed = false;
            let attempts = 0;
            const maxAttempts = 90;

            const trySolveCaptcha = async () => {
                const frames = page.frames();
                for (const frame of frames) {
                    const frameUrl = frame.url();

                    // Cloudflare Turnstile
                    if (frameUrl.includes('challenges.cloudflare.com')) {
                        try {
                            const cb = await frame.waitForSelector(
                                '#challenge-stage, .ctp-checkbox-label, input[type="checkbox"]',
                                { timeout: 1000 }
                            ).catch(() => null);
                            if (cb) {
                                await frame.evaluate(() => {
                                    const el = document.querySelector('#challenge-stage, .ctp-checkbox-label, input[type="checkbox"]');
                                    if (el) el.click();
                                }).catch(() => {});
                                await cb.click({ delay: 50 }).catch(() => {});
                                await new Promise(r => setTimeout(r, 3000));
                                return true;
                            }
                        } catch (e) {}
                    }

                    // hCaptcha - use puppeteer-hcaptcha to solve
                    if (frameUrl.includes('hcaptcha.com')) {
                        try {
                            console.log(`[${new Date().toISOString()}] hCaptcha detected, solving with puppeteer-hcaptcha...`);
                            await hcaptcha(page);
                            console.log(`[${new Date().toISOString()}] hCaptcha solved via library`);
                            await new Promise(r => setTimeout(r, 2000));
                            return true;
                        } catch (e) {
                            // Fallback: click checkbox manually
                            try {
                                const cb = await frame.waitForSelector(
                                    '#checkbox, #anchor, .check, [aria-checked]',
                                    { timeout: 1000 }
                                ).catch(() => null);
                                if (cb) {
                                    await frame.evaluate(() => {
                                        const el = document.querySelector('#checkbox, #anchor, .check, [aria-checked]');
                                        if (el) el.click();
                                    }).catch(() => {});
                                    await cb.click({ delay: 50 }).catch(() => {});
                                    await new Promise(r => setTimeout(r, 3000));
                                    return true;
                                }
                            } catch (e2) {}
                        }
                    }
                }
                return false;
            };

            while (!completed && attempts < maxAttempts) {
                await new Promise(r => setTimeout(r, 1000));
                attempts++;

                try {
                    const currentUrl = page.url();

                    if (
                        currentUrl.includes('checkout.stripe.com/return') ||
                        currentUrl.includes('hooks.stripe.com') ||
                        currentUrl.includes('payment_intent') ||
                        currentUrl.includes('succeeded') ||
                        currentUrl.includes('success_url') ||
                        currentUrl.includes('redirect_status=succeeded')
                    ) {
                        completed = true;
                        console.log(`[${new Date().toISOString()}] ✅ 3DS completed at: ${currentUrl}`);
                        break;
                    }

                    await trySolveCaptcha();

                    if (attempts % 5 === 0) {
                        const btns = await page.$$('button[type="submit"], input[type="submit"], .btn-primary, .continue-btn');
                        for (const btn of btns) {
                            if (await btn.isVisible() && await btn.isEnabled()) {
                                await btn.click();
                                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => {});
                                break;
                            }
                        }
                    }

                    if (attempts % 10 === 0) {
                        console.log(`[${new Date().toISOString()}] Still waiting... ${attempts}s/${maxAttempts}s`);
                    }
                } catch (e) {
                    console.error('Polling error:', e.message);
                }
            }
        }

        // Collect results
        const finalUrl = page.url();
        const finalTitle = await page.title();
        const finalContent = await page.content();
        const finalCookies = await page.cookies();

        let screenshotData = null;
        if (screenshot) {
            screenshotData = await page.screenshot({ encoding: 'base64', fullPage: true, type: 'png' });
        }

        let params = {};
        try {
            const urlParams = new URLSearchParams(new URL(finalUrl).search);
            for (const [key, value] of urlParams) params[key] = value;
        } catch (e) {}

        const result = {
            success: true,
            completed: true,
            url: finalUrl,
            title: finalTitle,
            cookies: finalCookies,
            params,
            screenshot: screenshotData || null,
            html: finalContent,
            source: params.source || null,
            payment_intent: params.payment_intent || null,
            redirect_status: params.redirect_status || null,
            client_secret: params.client_secret || null,
            processing_time: Date.now() - startTime
        };

        console.log(`[${new Date().toISOString()}] ✅ Done! Time: ${result.processing_time}ms`);
        return res.json(result);

    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ ERROR:`, error.message);
        return res.status(500).json({
            success: false,
            error: error.message,
            processing_time: Date.now() - startTime
        });
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

// ===== Start server =====
app.listen(PORT, () => {
    console.log(`✅ hCaptcha Solver API running on port ${PORT}`);
    console.log(`   Health:        http://localhost:${PORT}/health`);
    console.log(`   Solve hCaptcha: http://localhost:${PORT}/api/solve-hcaptcha`);
    console.log(`   3DS Automate:   http://localhost:${PORT}/api/3ds-automate`);
});
