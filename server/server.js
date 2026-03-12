const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

let browser = null;

async function getBrowser() {
    if (!browser || !browser.connected) {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1400,900'
            ]
        });
    }
    return browser;
}

app.post('/screenshot', async (req, res) => {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing query' });

    let page = null;
    try {
        const b = await getBrowser();
        page = await b.newPage();

        // Look like a real browser
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        );
        await page.setViewport({ width: 1400, height: 900 });

        // Block unnecessary resources for speed
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            if (['image', 'media', 'font'].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=20&hl=en`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        // Wait a moment for results to render
        await new Promise(r => setTimeout(r, 1500));

        // Check for CAPTCHA
        const hasCaptcha = await page.evaluate(() => {
            return document.body.innerText.includes('unusual traffic') ||
                   document.body.innerText.includes('not a robot') ||
                   !!document.querySelector('#captcha-form') ||
                   !!document.querySelector('iframe[src*="recaptcha"]');
        });

        if (hasCaptcha) {
            await page.close();
            return res.status(429).json({ error: 'captcha', message: 'Google CAPTCHA detected. Wait a few minutes and try again.' });
        }

        // Take full page screenshot of search results
        const screenshot = await page.screenshot({
            encoding: 'base64',
            fullPage: true,
            type: 'jpeg',
            quality: 85
        });

        await page.close();

        res.json({
            screenshot: 'data:image/jpeg;base64,' + screenshot,
            query
        });

    } catch (err) {
        console.error('Screenshot error:', err.message);
        if (page) await page.close().catch(() => {});
        res.status(500).json({ error: err.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

const PORT = 3456;
app.listen(PORT, () => {
    console.log('');
    console.log('  PDQ Screenshot Server running on:');
    console.log(`  http://localhost:${PORT}`);
    console.log('');
    console.log('  Keep this window open while using the rank tracker.');
    console.log('');
});

// Cleanup on exit
process.on('SIGINT', async () => {
    if (browser) await browser.close();
    process.exit();
});
