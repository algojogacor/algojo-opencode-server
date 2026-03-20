// ╔══════════════════════════════════════════════════════════════╗
// ║        ALGOJO OPENCODE SERVER v3 — Railway                  ║
// ║  Queue, Anti-double, Multi-file, Iterasi Append Mode        ║
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
const MAX_ITERATIONS = 5;

if (OLLAMA_API_KEY) process.env.OLLAMA_API_KEY = OLLAMA_API_KEY;

// ══════════════════════════════════════════════════════════════
// QUEUE SYSTEM
// ══════════════════════════════════════════════════════════════
const queue = [];
let isProcessing = false;

async function processQueue() {
    if (isProcessing || queue.length === 0) return;
    isProcessing = true;
    const job = queue.shift();
    try {
        const result = await executeBuild(job.data);
        job.resolve(result);
    } catch(e) {
        job.reject(e);
    } finally {
        isProcessing = false;
        processQueue(); // proses job berikutnya
    }
}

function addToQueue(data) {
    return new Promise((resolve, reject) => {
        queue.push({ data, resolve, reject });
        processQueue();
    });
}

// ══════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ══════════════════════════════════════════════════════════════
app.use((req, res, next) => {
    if (req.path === '/') return next();
    const key = req.headers['x-api-key'];
    if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
    next();
});

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════
function run(cmd, options = {}) {
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout: 300000, ...options }, (error, stdout, stderr) => {
            if (error) reject(new Error(stderr || error.message));
            else resolve(stdout);
        });
    });
}

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

function runOpenCode(prompt, sessionId = null) {
    const safePrompt = prompt.replace(/'/g, "'\\''");
    const sessionFlag = sessionId ? `--session ${sessionId} --continue` : '';
    const cmd = `cd ${BOT_DIR} && opencode run ${sessionFlag} '${safePrompt}'`;
    return new Promise((resolve) => {
        exec(cmd, { timeout: 300000 }, (error, stdout, stderr) => {
            resolve({ stdout: stdout || '', stderr: stderr || '', error });
        });
    });
}

function parseSignal(output) {
    try {
        const jsonMatch = output.match(/\{[^{}]*"status"\s*:\s*"(done|continue|question|error)"[^{}]*\}/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch(e) {}
    return null;
}

// Deteksi SEMUA file baru (multi-file support)
function detectNewFiles(before) {
    const nemoDir = path.join(BOT_DIR, 'commands', 'nemo');
    if (!fs.existsSync(nemoDir)) return [];
    const after = new Set(fs.readdirSync(nemoDir).filter(f => f.endsWith('.js')));
    return [...after].filter(f => !before.has(f));
}

// Deteksi file yang BERUBAH (untuk append mode)
function detectChangedFiles(before) {
    const nemoDir = path.join(BOT_DIR, 'commands', 'nemo');
    if (!fs.existsSync(nemoDir)) return [];
    return [...before].filter(f => {
        const fp = path.join(nemoDir, f);
        if (!fs.existsSync(fp)) return false;
        const stat = fs.statSync(fp);
        return stat.mtimeMs > Date.now() - 30000; // berubah dalam 30 detik terakhir
    });
}

// Cek apakah fitur sudah ada
function featureExists(featureName) {
    const nemoDir = path.join(BOT_DIR, 'commands', 'nemo');
    return fs.existsSync(path.join(nemoDir, `${featureName}.js`));
}

// Ekstrak nama fitur yang mungkin dari prompt
function extractFeatureName(prompt) {
    const words = prompt.toLowerCase()
        .replace(/buatkan|fitur|game|buat|tambah|feature|create/g, '')
        .trim()
        .split(/\s+/)
        .filter(w => w.length > 2);
    return words[0] || null;
}

async function gitPushAll(files, isfix = false) {
    const repoUrl = BOT_REPO.replace('https://', `https://${GITHUB_TOKEN}@`);
    const fileList = files.join(' ');
    const commitMsg = isfix
        ? `fix: perbaiki fitur by Algojo AI`
        : `feat: tambah fitur ${files.map(f => f.replace('.js','')).join(', ')} by Algojo AI`;
    await run([
        `cd ${BOT_DIR}`,
        `git remote set-url origin ${repoUrl}`,
        `git add ${files.map(f => `commands/nemo/${f}`).join(' ')}`,
        `git commit -m "${commitMsg}"`,
        `git push origin main`
    ].join(' && '));
}

function buildSystemPrompt(basePrompt, context = '') {
    return `${basePrompt}

PENTING — Aturan wajib:
1. Simpan file di commands/nemo/<namafitur>.js
2. Format modul WAJIB untuk SETIAP file:
   module.exports = async (command, args, msg, user, db, sock, m) => {
       if (command !== 'namacommand') return;
       // logika fitur
       await msg.reply(hasil);
   };
3. Kalau fitur kompleks butuh banyak file, buat semua file yang diperlukan
4. Di AKHIR response tulis JSON signal:
   - Selesai semua: {"status":"done","files":["file1.js","file2.js"]}
   - Perlu lanjut:  {"status":"continue","hint":"apa yang dilanjutkan","files_so_far":["file1.js"]}
   - Ada pertanyaan:{"status":"question","ask":"pertanyaan"}

${context ? `\nKonteks:\n${context}` : ''}`;
}

// ══════════════════════════════════════════════════════════════
// CORE BUILD FUNCTION
// ══════════════════════════════════════════════════════════════
async function executeBuild({ prompt, requester, forceUpdate = false }) {
    await setupRepo();

    const nemoDir = path.join(BOT_DIR, 'commands', 'nemo');
    if (!fs.existsSync(nemoDir)) fs.mkdirSync(nemoDir, { recursive: true });

    // ── Anti-double check ──────────────────────────────────
    const possibleName = extractFeatureName(prompt);
    if (possibleName && featureExists(possibleName) && !forceUpdate) {
        return {
            success: false,
            duplicate: true,
            existingFeature: possibleName,
            message: `Fitur !${possibleName} sudah ada! Mau update atau batal?`
        };
    }

    const filesBefore = new Set(fs.readdirSync(nemoDir).filter(f => f.endsWith('.js')));

    let sessionId = `algojo-${Date.now()}`;
    let iteration = 0;
    let lastHint = '';
    let allNewFiles = [];
    let questions = [];

    // ── Iterasi loop dengan append mode ───────────────────
    while (iteration < MAX_ITERATIONS) {
        iteration++;
        console.log(`[Build] Iterasi ${iteration}/${MAX_ITERATIONS}`);

        let iterPrompt;
        if (iteration === 1) {
            iterPrompt = buildSystemPrompt(prompt);
        } else {
            // Append mode: lanjut dari yang sudah ada
            const existingFiles = allNewFiles.map(f => {
                const fp = path.join(nemoDir, f);
                return fs.existsSync(fp)
                    ? `\n--- ${f} ---\n${fs.readFileSync(fp, 'utf8').slice(0, 1000)}...\n`
                    : '';
            }).join('');

            iterPrompt = buildSystemPrompt(
                `Lanjutkan pembuatan fitur. ${lastHint}`,
                `File yang sudah dibuat:\n${existingFiles}\n\nLanjutkan dari sini, jangan mulai ulang dari awal!`
            );
        }

        const result = await runOpenCode(iterPrompt, iteration > 1 ? sessionId : null);
        const output = result.stdout;

        // Deteksi file baru di iterasi ini
        const newThisIteration = detectNewFiles(filesBefore);
        newThisIteration.forEach(f => {
            if (!allNewFiles.includes(f)) allNewFiles.push(f);
        });

        // Parse signal
        const signal = parseSignal(output);
        console.log(`[Build] Signal iterasi ${iteration}:`, signal);

        if (signal) {
            if (signal.status === 'done') {
                // Merge files dari signal jika ada
                if (signal.files) {
                    signal.files.forEach(f => {
                        if (!allNewFiles.includes(f)) allNewFiles.push(f);
                    });
                }
                break;
            } else if (signal.status === 'continue') {
                lastHint = signal.hint || 'lanjutkan implementasi';
                if (signal.files_so_far) {
                    signal.files_so_far.forEach(f => {
                        if (!allNewFiles.includes(f)) allNewFiles.push(f);
                    });
                }
                continue;
            } else if (signal.status === 'question') {
                questions.push(signal.ask);
                lastHint = `Asumsikan pilihan terbaik dan lanjutkan`;
                continue;
            }
        }

        // Kalau tidak ada signal tapi ada file baru, anggap selesai
        if (allNewFiles.length > 0 && iteration >= 2) break;
    }

    // ── Validasi hasil ────────────────────────────────────
    const finalFiles = allNewFiles.filter(f =>
        fs.existsSync(path.join(nemoDir, f))
    );

    if (finalFiles.length === 0) {
        return {
            success: false,
            iterations: iteration,
            message: `Sudah ${iteration} iterasi tapi tidak ada file. Coba request lebih spesifik.`
        };
    }

    // ── Push semua file sekaligus ─────────────────────────
    await gitPushAll(finalFiles);

    const features = finalFiles.map(f => f.replace('.js', ''));
    console.log(`[Build] Berhasil: ${features.join(', ')} (${iteration} iterasi)`);

    return {
        success: true,
        features,
        feature: features[0], // backward compat
        iterations: iteration,
        questions: questions.length > 0 ? questions : undefined,
        message: `${features.length} fitur berhasil dibuat dalam ${iteration} iterasi!`
    };
}

// ══════════════════════════════════════════════════════════════
// ENDPOINTS
// ══════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
    res.json({
        status: 'running',
        version: '3.0',
        service: 'Algojo OpenCode Server',
        ollama: !!OLLAMA_API_KEY,
        github: !!GITHUB_TOKEN,
        queue: queue.length,
        processing: isProcessing
    });
});

// ── Build Feature ────────────────────────────────────────────
app.post('/build', async (req, res) => {
    const { prompt, requester, forceUpdate } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    const queuePosition = queue.length + (isProcessing ? 1 : 0);
    console.log(`[Build] Request masuk, posisi antrian: ${queuePosition}`);

    try {
        // Kalau antrian sudah 3+, tolak dulu
        if (queuePosition >= 3) {
            return res.json({
                success: false,
                queued: false,
                message: `Server sedang sibuk (${queuePosition} request antri). Coba lagi nanti!`
            });
        }

        // Kalau ada antrian, beri tahu posisi
        if (queuePosition > 0) {
            res.json({
                success: false,
                queued: true,
                position: queuePosition,
                message: `Request masuk antrian ke-${queuePosition}. Estimasi ${queuePosition * 3} menit.`
            });
            // Tetap proses di background
            addToQueue({ prompt, requester, forceUpdate }).then(() => {
                console.log(`[Queue] Job selesai untuk: ${prompt}`);
            }).catch(e => {
                console.error(`[Queue] Job error: ${e.message}`);
            });
            return;
        }

        // Langsung proses kalau tidak ada antrian
        const result = await addToQueue({ prompt, requester, forceUpdate });
        res.json(result);

    } catch (error) {
        console.error('[Build] Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── Fix Feature ──────────────────────────────────────────────
app.post('/fix', async (req, res) => {
    const { feature, errorLog, manualLog } = req.body;
    if (!feature) return res.status(400).json({ error: 'feature name required' });

    try {
        await setupRepo();

        const featureFile = path.join(BOT_DIR, 'commands', 'nemo', `${feature}.js`);
        if (!fs.existsSync(featureFile)) {
            return res.status(404).json({ error: `File ${feature}.js tidak ditemukan` });
        }

        const fileContent = fs.readFileSync(featureFile, 'utf8');
        const errorInfo = errorLog || manualLog || 'Unknown error';

        const fixPrompt = buildSystemPrompt(
            `Perbaiki bug pada fitur !${feature}`,
            `File saat ini:\n\`\`\`javascript\n${fileContent}\n\`\`\`\n\nError:\n${errorInfo}\n\nPerbaiki dan simpan ulang file yang SAMA (jangan buat file baru).`
        );

        let fixed = false;
        for (let i = 0; i < 3; i++) {
            const result = await runOpenCode(fixPrompt);
            const signal = parseSignal(result.stdout);
            if (signal?.status === 'done' || fs.existsSync(featureFile)) {
                fixed = true;
                break;
            }
        }

        if (!fixed) return res.json({ success: false, message: 'Gagal fix setelah 3x percobaan' });

        await gitPushAll([`${feature}.js`], true);
        res.json({ success: true, feature, message: `!${feature} berhasil diperbaiki!` });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── Queue Status ─────────────────────────────────────────────
app.get('/queue', (req, res) => {
    res.json({
        queue: queue.length,
        processing: isProcessing,
        total: queue.length + (isProcessing ? 1 : 0)
    });
});

// ── List Features ────────────────────────────────────────────
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
    console.log(`🤖 Algojo OpenCode Server v3 jalan di port ${PORT}`);
    console.log(`📦 Bot repo: ${BOT_REPO}`);
    console.log(`🔑 Ollama: ${OLLAMA_API_KEY ? 'configured' : 'NOT SET'}`);
    console.log(`🔑 GitHub: ${GITHUB_TOKEN ? 'configured' : 'NOT SET'}`);
    console.log(`🔄 Max iterasi: ${MAX_ITERATIONS}`);
    console.log(`📬 Queue: aktif`);
});
