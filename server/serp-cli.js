#!/usr/bin/env node
/**
 * PDQ Rank Tracker — Serper CLI
 *
 * Runs a real Google search via the Serper API straight from the terminal
 * and prints the top organic results plus the rank for any business term(s)
 * you provide. Same matching rules as the web UI: a term that looks like a
 * domain (contains a dot) matches the URL host AND any subdomain; a bare
 * brand word matches anywhere in the title / URL / snippet.
 *
 *   USAGE
 *     node serp-cli.js "<query>" [options]
 *
 *   OPTIONS
 *     --key <serperApiKey>     Override SERPER_API_KEY env var
 *     --biz "<a,b,c>"          Comma-separated business terms (domains or words)
 *     --location "<loc>"       Geo-located search (e.g. "Springfield, NJ")
 *     --num <N>                Results to fetch (default 20, max 100)
 *     --json                   Output raw JSON instead of formatted table
 *
 *   EXAMPLES
 *     node serp-cli.js "water damage restoration springfield nj" \
 *          --biz "pdqrestoration.com,pdqfirewaterdamage.com,pdq"
 *
 *     SERPER_API_KEY=xxxx node serp-cli.js "fire restoration" --location "Newark, NJ"
 *
 *   You can also pipe a list of queries — one per line — via stdin:
 *     cat queries.txt | node serp-cli.js --biz pdq
 */

const fs = require('fs');
const path = require('path');

// ---------------- CLI parsing ----------------
function parseArgs(argv) {
    const out = { _: [], json: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') out.json = true;
        else if (a === '--key') out.key = argv[++i];
        else if (a === '--biz') out.biz = argv[++i];
        else if (a === '--location') out.location = argv[++i];
        else if (a === '--num') out.num = parseInt(argv[++i], 10);
        else if (a === '-h' || a === '--help') out.help = true;
        else out._.push(a);
    }
    return out;
}

const args = parseArgs(process.argv);

if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 30).join('\n'));
    process.exit(0);
}

// ---------------- Resolve API key ----------------
function resolveApiKey() {
    if (args.key) return args.key.trim();
    if (process.env.SERPER_API_KEY) return process.env.SERPER_API_KEY.trim();
    // Convenience: read from server/data/.serper-key if you wrote one there
    const keyFile = path.join(__dirname, 'data', '.serper-key');
    if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, 'utf8').trim();
    return '';
}

const apiKey = resolveApiKey();
if (!apiKey) {
    console.error('No Serper API key found. Provide one of:');
    console.error('  --key <KEY>');
    console.error('  $env:SERPER_API_KEY = "<KEY>" (PowerShell)  /  export SERPER_API_KEY=<KEY> (bash)');
    console.error('  server/data/.serper-key  (single-line file)');
    process.exit(2);
}

// ---------------- Business matcher (mirrors web UI) ----------------
const businessTerms = (args.biz || '')
    .toLowerCase().split(/[,\n]/).map(s => s.trim()).filter(Boolean);

function getHostname(url) {
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
    catch (e) { return ''; }
}
function matchesBusiness(title, link, snippet) {
    if (businessTerms.length === 0) return false;
    const t = (title || '').toLowerCase();
    const l = (link || '').toLowerCase();
    const s = (snippet || '').toLowerCase();
    const host = getHostname(link);
    for (const term of businessTerms) {
        if (term.includes('.')) {
            const dom = term.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
            if (host === dom || host.endsWith('.' + dom)) return true;
            if (l.includes(dom)) return true;
        } else {
            if (t.includes(term) || l.includes(term) || s.includes(term)) return true;
        }
    }
    return false;
}

// ---------------- Serper call ----------------
async function search(query) {
    const body = { q: query, num: args.num || 20, gl: 'us' };
    if (args.location) body.location = args.location;

    const resp = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Serper ${resp.status}: ${text}`);
    }
    return resp.json();
}

function fmtRow(pos, title, host, isMatch) {
    const marker = isMatch ? '>>' : '  ';
    const p = String(pos).padStart(3, ' ');
    const h = (host || '').padEnd(35, ' ').slice(0, 35);
    return `${marker} ${p}  ${h}  ${title}`;
}

async function runOne(query) {
    const data = await search(query);
    const organic = data.organic || [];

    if (args.json) {
        const ranked = organic.map((e, i) => ({
            pos: i + 1,
            title: e.title || '',
            link: e.link || '',
            snippet: e.snippet || '',
            isBusiness: matchesBusiness(e.title, e.link, e.snippet)
        }));
        const match = ranked.find(r => r.isBusiness) || null;
        process.stdout.write(JSON.stringify({ query, location: args.location || null, businessRank: match ? match.pos : null, match, organic: ranked }, null, 2) + '\n');
        return;
    }

    console.log('');
    console.log(`Query:    ${query}`);
    if (args.location) console.log(`Location: ${args.location}`);
    if (businessTerms.length) console.log(`Business: ${businessTerms.join(', ')}`);
    console.log('-'.repeat(80));

    let businessRank = null;
    organic.forEach((e, i) => {
        const pos = i + 1;
        const host = getHostname(e.link);
        const isMatch = matchesBusiness(e.title, e.link, e.snippet);
        if (isMatch && businessRank === null) businessRank = pos;
        console.log(fmtRow(pos, e.title || '', host, isMatch));
    });

    console.log('-'.repeat(80));
    if (businessTerms.length) {
        if (businessRank) console.log(`*** Business rank: #${businessRank} ***`);
        else console.log('*** Business rank: not found in top ' + organic.length + ' ***');
    }
    console.log('');
}

// ---------------- Entry ----------------
async function readStdin() {
    return new Promise((resolve) => {
        if (process.stdin.isTTY) return resolve('');
        let buf = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', d => buf += d);
        process.stdin.on('end', () => resolve(buf));
    });
}

(async () => {
    let queries = args._.slice();
    const piped = await readStdin();
    if (piped.trim()) {
        queries = queries.concat(piped.split('\n').map(s => s.trim()).filter(Boolean));
    }

    if (queries.length === 0) {
        console.error('No query provided. Pass a query as an argument, or pipe queries on stdin.');
        console.error('Run with --help for usage.');
        process.exit(1);
    }

    try {
        for (const q of queries) {
            await runOne(q);
        }
    } catch (e) {
        console.error('Error:', e.message);
        process.exit(1);
    }
})();
