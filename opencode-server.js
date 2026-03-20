// ╔══════════════════════════════════════════════════════════════╗
// ║        ALGOJO OPENCODE SERVER v2 — Railway                  ║
// ║  Support: iterasi loop, session memory, auto-fix            ║
// ╚══════════════════════════════════════════════════════════════╝

const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENCODE_API_KEY || 'rahasia123';
const BOT_REPO = process.env.BOT_REPO || 'https://github.com/algojogacor/BOT-DISCORD.git';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;
const BOT_DIR = '/tmp/bot';
const MAX_ITERATIONS = 5; // batas maksimal loop

if (OLLAMA_API_KEY) process.env.OLLAMA_API_KEY = OLLAMA_API_KEY;

// ── Auth Middleware ──────────────────────────────────────────
app.use((req, res, next) => {
    if (req.path === '/') return next();
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

// ── Jalankan OpenCode dengan session ────────────────────────
function runOpenCode(prompt, sessionId = null) {
    const safePrompt = prompt.replace(/'/g, "'\\''");
    const sessionFlag = sessionId ? `--session ${sessionId}` : '';
    const cmd = `cd ${BOT_DIR} && opencode run ${sessionFlag} '${safePrompt}'`;
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout: 300000 }, (error, stdout, stderr) => {
            // Tetap resolve meski ada error — output tetap berguna
            resolve({ stdout: stdout || '', stderr: stderr || '', error });
        });
    });
}

// ── Parse JSON signal dari output OpenCode ───────────────────
function parseSignal(output) {
    try {
        // Cari JSON di akhir output
        const jsonMatch = output.match(/\{[^{}]*"status"\s*:\s*"(done|continue|question|error)"[^{}]*\}/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch(e) {}
    return null;
}

// ── Deteksi file baru ────────────────────────────────────────
function detectNewFiles(before) {
    const nemoDir = path.join(BOT_DIR, 'commands', 'nemo');
    if (!fs.existsSync(nemoDir)) return [];
    const after = new Set(fs.readdirSync(nemoDir).filter(f => f.endsWith('.js')));
    return [...after].filter(f => !before.has(f));
}

// ── Deteksi file yang berubah ────────────────────────────────
function detectChangedFiles(filenames) {
    return filenames.filter(f => {
        const filepath = path.join(BOT_DIR, 'commands', 'nemo', f);
        return fs.existsSync(filepath);
    });
}

// ── Git push ─────────────────────────────────────────────────
async function gitPush(filename, isfix = false) {
    const repoUrl = BOT_REPO.replace('https://', `https://${GITHUB_TOKEN}@`);
    const cmdName = filename.replace('.js', '');
    const msg = isfix
        ? `fix: perbaiki fitur ${cmdName} by Algojo AI`
        : `feat: tambah fitur ${cmdName} by Algojo AI`;
    await run([
        `cd ${BOT_DIR}`,
        `git remote set-url origin ${repoUrl}`,
        `git add commands/nemo/${filename}`,
        `git commit -m "${msg}"`,
        `git push origin main`
    ].join(' && '));
}

// ── SYSTEM PROMPT untuk OpenCode ────────────────────────────
function buildSystemPrompt(basePrompt, context = '') {
    return `${basePrompt}

PENTING — Format response kamu:
1. Tulis kode lengkap di file commands/nemo/<namafitur>.js
2. Format modul WAJIB:
   module.exports = async (command, args, msg, user, db, sock, m) => {
       if (command !== 'namacommand') return;
       // logika fitur
       await msg.reply(hasil);
   };
3. Di AKHIR response, tulis SALAH SATU JSON signal ini:
   - Kalau SELESAI: {"status":"done","file":"namafile.js"}
   - Kalau PERLU LANJUT: {"status":"continue","hint":"apa yang harus dilanjutkan"}
   - Kalau ADA PERTANYAAN: {"status":"question","ask":"pertanyaan kamu"}

${context ? `Konteks tambahan:\n${context}` : ''}`;
}

// ── ENDPOINT: Health Check ───────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        status: 'running',
        version: '2.0',
        service: 'Algojo OpenCode Server',
        ollama: !!OLLAMA_API_KEY,
        github: !!GITHUB_TOKEN
    });
});

// ── ENDPOINT: Build Feature (dengan iterasi loop) ────────────
app.post('/build', async (req, res) => {
    const { prompt, requester } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    console.log(`[Build] Request: ${prompt}`);

    try {
        await setupRepo();

        const nemoDir = path.join(BOT_DIR, 'commands', 'nemo');
        if (!fs.existsSync(nemoDir)) fs.mkdirSync(nemoDir, { recursive: true });
        const filesBefore = new Set(fs.readdirSync(nemoDir).filter(f => f.endsWith('.js')));

        let sessionId = null;
        let iteration = 0;
        let lastHint = '';
        let finalFile = null;
        let questions = [];

        // ── Loop iterasi ─────────────────────────────────────
        while (iteration < MAX_ITERATIONS) {
            iteration++;
            console.log(`[Build] Iterasi ${iteration}/${MAX_ITERATIONS}`);

            const systemPrompt = iteration === 1
                ? buildSystemPrompt(prompt)
                : buildSystemPrompt(`Lanjutkan pembuatan fitur sebelumnya. ${lastHint}`, `Ini adalah iterasi ke-${iteration}`);

            const result = await runOpenCode(systemPrompt, sessionId);
            const output = result.stdout;

            console.log(`[Build] Output iterasi ${iteration}: ${output.slice(-200)}`);

            // Parse signal JSON dari output
            const signal = parseSignal(output);

            if (signal) {
                if (signal.status === 'done') {
                    finalFile = signal.file;
                    console.log(`[Build] AI selesai, file: ${finalFile}`);
                    break;
                } else if (signal.status === 'continue') {
                    lastHint = signal.hint || 'lanjutkan';
                    console.log(`[Build] AI minta lanjut: ${lastHint}`);
                    continue;
                } else if (signal.status === 'question') {
                    questions.push(signal.ask);
                    console.log(`[Build] AI bertanya: ${signal.ask}`);
                    // Jawab otomatis: lanjut saja dengan best guess
                    lastHint = `Asumsikan pilihan terbaik dan lanjutkan pembuatan fitur`;
                    continue;
                }
            }

            // Kalau tidak ada signal, cek apakah ada file baru
            const newFiles = detectNewFiles(filesBefore);
            if (newFiles.length > 0) {
                finalFile = newFiles[0];
                console.log(`[Build] File baru terdeteksi: ${finalFile}`);
                break;
            }

            // Kalau tidak ada signal dan tidak ada file baru, lanjut
            lastHint = 'Selesaikan pembuatan file dan simpan ke commands/nemo/';
        }

        // ── Cek hasil ────────────────────────────────────────
        const newFiles = detectNewFiles(filesBefore);
        if (newFiles.length === 0 && !finalFile) {
            return res.json({
                success: false,
                iterations: iteration,
                message: `Sudah ${iteration} iterasi tapi tidak ada file baru. Coba request lebih spesifik.`
            });
        }

        const targetFile = finalFile || newFiles[0];
        const targetFilename = path.basename(targetFile);

        // Push ke GitHub
        await gitPush(targetFilename);

        const feature = targetFilename.replace('.js', '');
        console.log(`[Build] Berhasil setelah ${iteration} iterasi: ${feature}`);

        res.json({
            success: true,
            feature,
            iterations: iteration,
            questions: questions.length > 0 ? questions : undefined,
            message: `Fitur !${feature} berhasil dibuat dalam ${iteration} iterasi!`
        });

    } catch (error) {
        console.error('[Build] Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── ENDPOINT: Fix Feature ────────────────────────────────────
app.post('/fix', async (req, res) => {
    const { feature, errorLog, manualLog } = req.body;
    if (!feature) return res.status(400).json({ error: 'feature name required' });

    console.log(`[Fix] Memperbaiki: ${feature}`);

    try {
        await setupRepo();

        const featureFile = path.join(BOT_DIR, 'commands', 'nemo', `${feature}.js`);
        if (!fs.existsSync(featureFile)) {
            return res.status(404).json({ error: `File ${feature}.js tidak ditemukan` });
        }

        // Baca isi file yang error
        const fileContent = fs.readFileSync(featureFile, 'utf8');
        const errorInfo = errorLog || manualLog || 'Unknown error';

        const fixPrompt = buildSystemPrompt(
            `Perbaiki bug pada fitur !${feature} di file commands/nemo/${feature}.js`,
            `Isi file saat ini:\n\`\`\`javascript\n${fileContent}\n\`\`\`\n\nError log:\n${errorInfo}\n\nPerbaiki bug tersebut dan simpan ulang file yang sama.`
        );

        let iteration = 0;
        let fixed = false;

        while (iteration < 3) {
            iteration++;
            console.log(`[Fix] Iterasi fix ${iteration}`);

            const result = await runOpenCode(fixPrompt);
            const signal = parseSignal(result.stdout);

            if (signal?.status === 'done' || fs.existsSync(featureFile)) {
                fixed = true;
                break;
            }
        }

        if (!fixed) {
            return res.json({ success: false, message: 'Gagal memperbaiki setelah 3 percobaan' });
        }

        // Push fix ke GitHub
        await gitPush(`${feature}.js`, true);

        res.json({
            success: true,
            feature,
            message: `Fitur !${feature} berhasil diperbaiki!`
        });

    } catch (error) {
        console.error('[Fix] Error:', error.message);
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
    console.log(`🤖 Algojo OpenCode Server v2 jalan di port ${PORT}`);
    console.log(`📦 Bot repo: ${BOT_REPO}`);
    console.log(`🔑 Ollama: ${OLLAMA_API_KEY ? 'configured' : 'NOT SET'}`);
    console.log(`🔑 GitHub: ${GITHUB_TOKEN ? 'configured' : 'NOT SET'}`);
    console.log(`🔄 Max iterasi: ${MAX_ITERATIONS}`);
});
