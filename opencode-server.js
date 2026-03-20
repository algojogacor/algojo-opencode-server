// ╔══════════════════════════════════════════════════════════════╗
// ║        ALGOJO OPENCODE SERVER                               ║
// ║  Menerima request dari Bot WA → jalankan OpenCode           ║
// ╚══════════════════════════════════════════════════════════════╝

const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENCODE_API_KEY || 'rahasia123';
const BOT_REPO = process.env.BOT_REPO || 'https://github.com/algojogacor/BOT-DISCORD.git';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;
const BOT_DIR = '/tmp/bot';

// Set Ollama API key ke environment
if (OLLAMA_API_KEY) process.env.OLLAMA_API_KEY = OLLAMA_API_KEY;

// ── Auth Middleware ──────────────────────────────────────────
app.use((req, res, next) => {
    if (req.path === '/') return next(); // health check bebas
    const key = req.headers['x-api-key'];
    if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
    next();
});

// ── Helper: jalankan command ─────────────────────────────────
function run(cmd, options = {}) {
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout: 300000, ...options }, (error, stdout, stderr) => {
            if (error) reject(new Error(stderr || error.message));
            else resolve(stdout);
        });
    });
}

// ── Setup repo bot ───────────────────────────────────────────
async function setupRepo() {
    const repoUrl = BOT_REPO.replace('https://', `https://${GITHUB_TOKEN}@`);
    if (fs.existsSync(path.join(BOT_DIR, '.git'))) {
        await run(`cd ${BOT_DIR} && git pull origin main`);
    } else {
        fs.mkdirSync(BOT_DIR, { recursive: true });
        await run(`git clone ${repoUrl} ${BOT_DIR}`);
        await run(`cd ${BOT_DIR} && git config user.email "algojo@bot.com" && git config user.name "Algojo AI"`);
    }
}

// ── Jalankan OpenCode ────────────────────────────────────────
function runOpenCode(prompt) {
    const safePrompt = prompt.replace(/'/g, "'\\''");
    return run(`cd ${BOT_DIR} && opencode run '${safePrompt}'`);
}

// ── Deteksi file baru di /commands/nemo/ ─────────────────────
function detectNewFiles(before) {
    const nemoDir = path.join(BOT_DIR, 'commands', 'nemo');
    if (!fs.existsSync(nemoDir)) return [];
    const after = new Set(fs.readdirSync(nemoDir).filter(f => f.endsWith('.js')));
    return [...after].filter(f => !before.has(f));
}

// ── Git push ─────────────────────────────────────────────────
async function gitPush(filename) {
    const repoUrl = BOT_REPO.replace('https://', `https://${GITHUB_TOKEN}@`);
    const cmdName = filename.replace('.js', '');
    await run([
        `cd ${BOT_DIR}`,
        `git remote set-url origin ${repoUrl}`,
        `git add commands/nemo/${filename}`,
        `git commit -m "feat: tambah fitur ${cmdName} by Algojo AI"`,
        `git push origin main`
    ].join(' && '));
}

// ── ENDPOINT: Health Check ───────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        status: 'running',
        service: 'Algojo OpenCode Server',
        ollama: !!OLLAMA_API_KEY,
        github: !!GITHUB_TOKEN
    });
});

// ── ENDPOINT: Build Feature ──────────────────────────────────
app.post('/build', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    console.log(`[Build] Request: ${prompt}`);

    try {
        await setupRepo();

        const nemoDir = path.join(BOT_DIR, 'commands', 'nemo');
        if (!fs.existsSync(nemoDir)) fs.mkdirSync(nemoDir, { recursive: true });
        const filesBefore = new Set(fs.readdirSync(nemoDir).filter(f => f.endsWith('.js')));

        const fullPrompt = `${prompt}. Simpan file baru di commands/nemo/ sesuai nama fitur. Format modul wajib: module.exports = async (command, args, msg, user, db, sock, m) => { if (command !== 'namacommand') return; ... await msg.reply(hasil); }`;
        await runOpenCode(fullPrompt);

        const newFiles = detectNewFiles(filesBefore);
        if (newFiles.length === 0) {
            return res.json({ success: false, message: 'OpenCode selesai tapi tidak ada file baru' });
        }

        await gitPush(newFiles[0]);

        const feature = newFiles[0].replace('.js', '');
        console.log(`[Build] Berhasil: ${feature}`);

        res.json({
            success: true,
            feature,
            message: `Fitur !${feature} berhasil dibuat dan dipush ke GitHub!`
        });

    } catch (error) {
        console.error('[Build] Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── ENDPOINT: List Features ──────────────────────────────────
app.get('/features', async (req, res) => {
    try {
        await setupRepo();
        const nemoDir = path.join(BOT_DIR, 'commands', 'nemo');
        const files = fs.existsSync(nemoDir)
            ? fs.readdirSync(nemoDir).filter(f => f.endsWith('.js')).map(f => f.replace('.js', ''))
            : [];
        res.json({ features: files, count: files.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🤖 Algojo OpenCode Server jalan di port ${PORT}`);
    console.log(`📦 Bot repo: ${BOT_REPO}`);
    console.log(`🔑 Ollama: ${OLLAMA_API_KEY ? 'configured' : 'NOT SET'}`);
    console.log(`🔑 GitHub: ${GITHUB_TOKEN ? 'configured' : 'NOT SET'}`);
});
