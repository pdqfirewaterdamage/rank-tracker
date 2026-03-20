const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve index.html from parent directory
app.use(express.static(path.join(__dirname, '..')));

// ============================================================
// DATA PERSISTENCE (JSON file)
// ============================================================
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'projects.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// GET /data — load all project data
app.get('/data', (req, res) => {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            res.json(JSON.parse(raw));
        } else {
            res.json({ projects: [], activeProjectId: null });
        }
    } catch (err) {
        console.error('Error reading data file:', err.message);
        res.json({ projects: [], activeProjectId: null });
    }
});

// PUT /data — save all project data
app.put('/data', (req, res) => {
    try {
        const d = req.body;
        if (!d || !Array.isArray(d.projects)) {
            return res.status(400).json({ error: 'Invalid data format' });
        }
        fs.writeFileSync(DATA_FILE, JSON.stringify(d), 'utf8');
        res.json({ ok: true });
    } catch (err) {
        console.error('Error writing data file:', err.message);
        res.status(500).json({ error: err.message });
    }
});

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

// Shared function to open Google search page
async function openSearchPage(query) {
    const b = await getBrowser();
    const page = await b.newPage();

    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1400, height: 900 });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const type = req.resourceType();
        if (['media', 'font'].includes(type)) {
            req.abort();
        } else {
            req.continue();
        }
    });

    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=20&hl=en`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    // Check for CAPTCHA
    const hasCaptcha = await page.evaluate(() => {
        return document.body.innerText.includes('unusual traffic') ||
               document.body.innerText.includes('not a robot') ||
               !!document.querySelector('#captcha-form') ||
               !!document.querySelector('iframe[src*="recaptcha"]');
    });

    if (hasCaptcha) {
        await page.close();
        throw new Error('CAPTCHA');
    }

    return page;
}

// Screenshot-only endpoint (legacy)
app.post('/screenshot', async (req, res) => {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing query' });

    let page = null;
    try {
        page = await openSearchPage(query);

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
        if (page) await page.close().catch(() => {});
        if (err.message === 'CAPTCHA') {
            return res.status(429).json({ error: 'captcha', message: 'Google CAPTCHA detected.' });
        }
        console.error('Screenshot error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Full scrape endpoint: extracts LSA, PPC, Map Pack, Organic + screenshot
app.post('/scrape', async (req, res) => {
    const { query, businessTerms } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing query' });

    const terms = (businessTerms || []).map(t => t.toLowerCase());
    let page = null;

    try {
        page = await openSearchPage(query);

        // Scrape all SERP sections from the DOM
        const serpData = await page.evaluate((searchTerms) => {
            function matchesBusiness(text) {
                if (!searchTerms || searchTerms.length === 0) return false;
                const lower = text.toLowerCase();
                return searchTerms.some(term => lower.includes(term));
            }

            function getTextContent(el, selector) {
                const child = el.querySelector(selector);
                return child ? child.textContent.trim() : '';
            }

            // ---- LOCAL SERVICE ADS ----
            const lsaResults = [];
            // LSA ads appear at very top with "Google Guaranteed" or "Google Screened" badges
            const lsaContainers = document.querySelectorAll('[data-hveid] .google-guaranteed, [data-attrid*="local_service"], .lsa-single-ad, [data-pool-id]');
            // Also try broader selectors for LSA
            document.querySelectorAll('.yp1CPe, .xpd').forEach(el => {
                const text = el.textContent || '';
                if ((text.includes('Google Guaranteed') || text.includes('Google Screened')) && !el.closest('#search')) {
                    const title = el.querySelector('span[role="heading"], .NVbCr, .OSrXXb')?.textContent?.trim() || '';
                    const link = el.querySelector('a')?.href || '';
                    if (title) lsaResults.push({ title, link, snippet: '' });
                }
            });

            // ---- PPC ADS ----
            const ppcResults = [];
            // Ads are marked with "Sponsored" label, typically in #tads (top ads) or #bottomads
            const adContainers = document.querySelectorAll('#tads .uEierd, #tads .CnP9N, #tads [data-text-ad], #tads .v5yQqb, [data-is-ad] , .commercial-unit-desktop-top .ad_cclk');
            adContainers.forEach(ad => {
                const titleEl = ad.querySelector('h3, [role="heading"], .CCgQ5');
                const linkEl = ad.querySelector('a[data-rw], a[href*="googleadservices"], a.sVXRqc, a.cz3goc') || ad.querySelector('a');
                const snippetEl = ad.querySelector('.MUxGbd, .yDYNvb, .lyLwlc');
                const title = titleEl ? titleEl.textContent.trim() : '';
                const link = linkEl ? linkEl.href : '';
                const snippet = snippetEl ? snippetEl.textContent.trim() : '';
                if (title) ppcResults.push({ title, link, snippet });
            });

            // Fallback: look for any "Sponsored" labeled blocks
            if (ppcResults.length === 0) {
                document.querySelectorAll('#tads > div, [aria-label="Ads"] > div').forEach(ad => {
                    const title = ad.querySelector('h3, [role="heading"]')?.textContent?.trim() || '';
                    const link = ad.querySelector('a')?.href || '';
                    const snippet = ad.querySelector('.MUxGbd, .yDYNvb')?.textContent?.trim() || '';
                    if (title && link) ppcResults.push({ title, link, snippet });
                });
            }

            // ---- MAP PACK ----
            const mapResults = [];
            // Map pack results are inside .rllt__link or .VkpGBb or local pack container
            const mapContainer = document.querySelector('.Gx5Zad, [data-local-attribute="d3bn"], .AEprdc, #local-pack, [jscontroller="bFsLpd"]');
            const mapItems = document.querySelectorAll('.rllt__link, [data-cid], .VkpGBb a, [jsaction*="placeCard"]');
            const seenMapNames = new Set();
            mapItems.forEach(item => {
                const nameEl = item.querySelector('.OSrXXb, .dbg0pd, .rllt__details .dbg0pd, [aria-level]') || item.querySelector('span[class]');
                const name = nameEl ? nameEl.textContent.trim() : item.textContent.trim().split('\n')[0];
                const link = item.href || item.querySelector('a')?.href || '';
                const ratingEl = item.querySelector('.BTtC6e, .Y0A0hc, .MW4etd, span[aria-label*="stars"], span[aria-label*="rating"]');
                const rating = ratingEl ? ratingEl.textContent.trim() : '';
                if (name && name.length < 100 && !seenMapNames.has(name)) {
                    seenMapNames.add(name);
                    mapResults.push({ title: name, link, rating });
                }
            });

            // Broader fallback for map pack
            if (mapResults.length === 0) {
                const localEl = document.querySelector('[data-attrid="kc:/location/location:address"]')?.closest('[data-hveid]');
                document.querySelectorAll('.cXedhc a, .rlfl__tls a').forEach(item => {
                    const name = item.querySelector('.OSrXXb, .dbg0pd')?.textContent?.trim() || item.textContent.trim().split('\n')[0];
                    if (name && name.length < 100 && !seenMapNames.has(name)) {
                        seenMapNames.add(name);
                        mapResults.push({ title: name, link: item.href || '', rating: '' });
                    }
                });
            }

            // ---- ORGANIC ----
            const organicResults = [];
            const organicItems = document.querySelectorAll('#search .g:not(.g .g), #rso > div > div.g, #rso .MjjYud .g');
            const seenLinks = new Set();
            organicItems.forEach(item => {
                // Skip if it's inside an ad container
                if (item.closest('#tads, #bottomads, [data-is-ad]')) return;
                const titleEl = item.querySelector('h3');
                const linkEl = item.querySelector('a[href]');
                const snippetEl = item.querySelector('.VwiC3b, .IsZvec, [data-sncf], .yXK7lf');
                const title = titleEl ? titleEl.textContent.trim() : '';
                const link = linkEl ? linkEl.href : '';
                const snippet = snippetEl ? snippetEl.textContent.trim() : '';
                if (title && link && !seenLinks.has(link) && !link.includes('google.com/search')) {
                    seenLinks.add(link);
                    organicResults.push({ title, link, snippet });
                }
            });

            return {
                lsa: lsaResults.slice(0, 10),
                ppc: ppcResults.slice(0, 10),
                mapPack: mapResults.slice(0, 10),
                organic: organicResults.slice(0, 20)
            };
        }, terms);

        // Take screenshot
        const screenshot = await page.screenshot({
            encoding: 'base64',
            fullPage: true,
            type: 'jpeg',
            quality: 80
        });

        await page.close();

        // Find business rank in each section
        function findRank(results) {
            for (let i = 0; i < results.length; i++) {
                const text = (results[i].title + ' ' + (results[i].link || '') + ' ' + (results[i].snippet || '')).toLowerCase();
                if (terms.some(t => text.includes(t))) {
                    return { rank: i + 1, title: results[i].title, url: results[i].link || '' };
                }
            }
            return { rank: 0, title: '', url: '' };
        }

        const lsaRank = findRank(serpData.lsa);
        const ppcRank = findRank(serpData.ppc);
        const mapRank = findRank(serpData.mapPack);
        const organicRank = findRank(serpData.organic);

        console.log(`  [${query}] LSA:${serpData.lsa.length} PPC:${serpData.ppc.length} Map:${serpData.mapPack.length} Org:${serpData.organic.length}`);

        res.json({
            query,
            screenshot: 'data:image/jpeg;base64,' + screenshot,
            serpData,
            ranks: {
                lsa: lsaRank,
                ppc: ppcRank,
                map: mapRank,
                organic: organicRank
            }
        });

    } catch (err) {
        if (page) await page.close().catch(() => {});
        if (err.message === 'CAPTCHA') {
            return res.status(429).json({ error: 'captcha', message: 'Google CAPTCHA detected. Wait a few minutes.' });
        }
        console.error('Scrape error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', scrapeEnabled: true });
});

const PORT = 3456;
app.listen(PORT, () => {
    console.log('');
    console.log('  PDQ Screenshot + Scrape Server running on:');
    console.log(`  http://localhost:${PORT}`);
    console.log('');
    console.log('  Endpoints:');
    console.log('    POST /scrape    - Full SERP scrape (LSA, PPC, Map, Organic) + screenshot');
    console.log('    POST /screenshot - Screenshot only');
    console.log('    GET  /health    - Health check');
    console.log('');
    console.log('  Keep this window open while using the rank tracker.');
    console.log('');
});

// Cleanup on exit
process.on('SIGINT', async () => {
    if (browser) await browser.close();
    process.exit();
});
