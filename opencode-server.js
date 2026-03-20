// ╔══════════════════════════════════════════════════════════════╗
// ║        ALGOJO OPENCODE SERVER v4 — Railway                  ║
// ║  Queue, Anti-double, Multi-file, Log thinking, Webhook      ║
// ╚══════════════════════════════════════════════════════════════╝

const express = require('express');
const { exec, spawn } = require('child_process');
const https = require('https');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENCODE_API_KEY || 'rahasia123';
const BOT_REPO = process.env.BOT_REPO || 'https://github.com/algojogacor/BOT-DISCORD.git';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;
const BOT_WEBHOOK_URL = process.env.BOT_WEBHOOK_URL || '';
const BOT_WEBHOOK_KEY = process.env.BOT_WEBHOOK_KEY || 'rahasia123';
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
        processQueue();
    }
}

function addToQueue(data) {
    return new Promise((resolve, reject) => {
        queue.push({ data, resolve, reject });
        processQueue();
    });
}

// ══════════════════════════════════════════════════════════════
// WEBHOOK KE BOT WA
// ══════════════════════════════════════════════════════════════
function sendWebhook(payload) {
    if (!BOT_WEBHOOK_URL) return Promise.resolve();
    return new Promise((resolve) => {
        try {
            const body = JSON.stringify(payload);
            const url = new URL(BOT_WEBHOOK_URL);
            const options = {
                hostname: url.hostname,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'x-webhook-key': BOT_WEBHOOK_KEY
                }
            };
            const req = https.request(options, () => resolve());
            req.on('error', () => resolve()); // jangan sampai crash
            req.setTimeout(10000, () => { req.destroy(); resolve(); });
            req.write(body);
            req.end();
        } catch(e) {
            resolve();
        }
    });
}

// ══════════════════════════════════════════════════════════════
// IN-MEMORY LOG BUFFER — untuk polling dari luar
// ══════════════════════════════════════════════════════════════
const buildLogs = [];
const MAX_LOGS = 100;

function addLog(msg) {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    console.log(entry);
    buildLogs.push(entry);
    if (buildLogs.length > MAX_LOGS) buildLogs.shift();
}


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
        exec(cmd, { timeout: 300000, maxBuffer: 1024 * 1024 * 10, ...options }, (error, stdout, stderr) => {
            if (error) {
                // Sensor token agar tidak bocor di log
                const safeMsg = (stderr || error.message)
                    .replace(GITHUB_TOKEN || '', '[TOKEN]')
                    .replace(OLLAMA_API_KEY || '', '[TOKEN]');
                reject(new Error(safeMsg));
            } else {
                resolve(stdout);
            }
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
    return new Promise((resolve) => {
        const spawnArgs = ['run'];
        if (sessionId) {
            spawnArgs.push('--session', sessionId, '--continue');
        }
        spawnArgs.push(prompt);

        console.log(`[OpenCode] Menjalankan: ${prompt.slice(0, 80)}...`);
        addLog(`OpenCode start: ${prompt.slice(0, 80)}`);
        if (sessionId) addLog(`Session: ${sessionId}`);

        const child = spawn('opencode', spawnArgs, {
            cwd: BOT_DIR,
            timeout: 300000,
            env: {
                ...process.env,
                FORCE_COLOR: '0',
                NO_COLOR: '1',
                CI: '1'  // banyak CLI disable buffer di CI mode
            }
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', d => {
            const chunk = d.toString();
            stdout += chunk;
            process.stdout.write(`[OpenCode Output] ${chunk}`);
            // Simpan ke buffer untuk polling
            addLog(`AI: ${chunk.slice(0, 200)}`);
        });

        child.stderr.on('data', d => {
            const chunk = d.toString();
            stderr += chunk;
            process.stderr.write(`[OpenCode Stderr] ${chunk}`);
        });

        child.on('close', (code) => {
            console.log(`[OpenCode] Selesai dengan exit code: ${code}`);
            console.log(`[OpenCode] Total output: ${stdout.length} chars`);
            resolve({ stdout, stderr, error: null });
        });

        child.on('error', (err) => {
            console.error(`[OpenCode] Error:`, err.message);
            resolve({ stdout, stderr, error: err });
        });

        setTimeout(() => {
            console.log('[OpenCode] TIMEOUT — killing process');
            child.kill();
            resolve({ stdout, stderr, error: new Error('Timeout') });
        }, 290000);
    });
}

function parseSignal(output) {
    try {
        const jsonMatch = output.match(/\{[^{}]*"status"\s*:\s*"(done|continue|question|error)"[^{}]*\}/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch(e) {}
    return null;
}

// Ekstrak thinking/log dari output (buang JSON signal)
function extractThinking(output) {
    return output
        .replace(/\{[^{}]*"status"\s*:\s*"[^"]*"[^{}]*\}/g, '')
        .replace(/```[^`]*```/g, '[kode tersimpan]')
        .trim()
        .slice(0, 2000); // max 2000 karakter
}

// Ekstrak cara penggunaan dari output
function extractUsage(output, featureName) {
    // Cari section usage/cara pakai di output
    const usageMatch = output.match(/(?:cara\s*(?:pakai|penggunaan|use)|usage|command)[:\s]*([^\n]+(?:\n[^\n{]+)*)/i);
    if (usageMatch) return usageMatch[1].trim().slice(0, 500);
    return `Ketik !${featureName} untuk menggunakan fitur ini.`;
}

function detectNewFiles(before) {
    const nemoDir = path.join(BOT_DIR, 'commands', 'nemo');
    if (!fs.existsSync(nemoDir)) return [];
    const after = new Set(fs.readdirSync(nemoDir).filter(f => f.endsWith('.js')));
    return [...after].filter(f => !before.has(f));
}

// Cek duplikat dengan cara lebih cerdas
// Bandingkan semua kata di prompt dengan semua nama fitur yang ada
function checkDuplicate(prompt) {
    const nemoDir = path.join(BOT_DIR, 'commands', 'nemo');
    if (!fs.existsSync(nemoDir)) return null;

    const existing = fs.readdirSync(nemoDir)
        .filter(f => f.endsWith('.js'))
        .map(f => f.replace('.js', '').toLowerCase());

    if (existing.length === 0) return null;

    // Bersihkan prompt dari kata-kata umum
    const cleanPrompt = prompt.toLowerCase()
        .replace(/buatkan|buatin|fitur|game|buat|tambah|feature|create|tolong|coba|jadikan|tambahkan/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .trim();

    const promptWords = cleanPrompt.split(/\s+/).filter(w => w.length > 2);

    // Cek exact match atau substring match
    for (const name of existing) {
        // Exact match dengan salah satu kata di prompt
        if (promptWords.includes(name)) return name;

        // Nama fitur ada di dalam prompt (misal "jadwalsholat" di "jadwal sholat")
        if (cleanPrompt.replace(/\s/g, '').includes(name)) return name;

        // Prompt mengandung semua kata yang ada di nama fitur
        const nameWords = name.split(/(?=[A-Z])|_|-/).map(w => w.toLowerCase());
        if (nameWords.length > 1 && nameWords.every(w => promptWords.includes(w))) return name;

        // Fuzzy: minimal 80% kata prompt cocok dengan nama fitur
        const matchCount = promptWords.filter(w =>
            name.includes(w) || w.includes(name.slice(0, 4))
        ).length;
        if (matchCount >= 1 && name.length > 4 && promptWords.some(w => name.startsWith(w.slice(0, 4)))) return name;
    }

    return null;
}

async function gitPushAll(files, isfix = false) {
    const repoUrl = BOT_REPO.replace('https://', `https://${GITHUB_TOKEN}@`);
    const commitMsg = isfix
        ? `fix: perbaiki fitur by Algojo AI`
        : `feat: tambah ${files.map(f => f.replace('.js','')).join(', ')} by Algojo AI`;
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
2. Format modul WAJIB:
   module.exports = async (command, args, msg, user, db, sock, m) => {
       if (command !== 'namacommand') return;
       await msg.reply(hasil);
   };
3. Tulis CARA PENGGUNAAN sebelum JSON signal, format:
   CARA PAKAI:
   • !namafitur → fungsi utama
   • !namafitur <arg> → contoh dengan argumen
4. Di AKHIR tulis JSON signal:
   - Selesai: {"status":"done","files":["file1.js"],"usage":"cara singkat pakai fitur"}
   - Lanjut:  {"status":"continue","hint":"apa dilanjutkan","files_so_far":["file1.js"]}
   - Tanya:   {"status":"question","ask":"pertanyaan"}

${context ? `\nKonteks:\n${context}` : ''}`;
}

// ══════════════════════════════════════════════════════════════
// CORE BUILD FUNCTION
// ══════════════════════════════════════════════════════════════
async function executeBuild({ prompt, requester, groupId, forceUpdate = false }) {
    await setupRepo();

    const nemoDir = path.join(BOT_DIR, 'commands', 'nemo');
    if (!fs.existsSync(nemoDir)) fs.mkdirSync(nemoDir, { recursive: true });

    // Anti-double check — lebih akurat
    const existingFeature = !forceUpdate ? checkDuplicate(prompt) : null;
    if (existingFeature) {
        return {
            success: false,
            duplicate: true,
            existingFeature,
            groupId,
            message: `Fitur !${existingFeature} sudah ada!`
        };
    }

    const filesBefore = new Set(fs.readdirSync(nemoDir).filter(f => f.endsWith('.js')));
    const sessionId = `algojo-${Date.now()}`;
    let iteration = 0;
    let lastHint = '';
    let allNewFiles = [];
    let questions = [];
    let allThinking = []; // kumpulkan semua thinking
    let finalUsage = '';

    // Kirim notif mulai ke grup yang request
    if (groupId) {
        await sendWebhook({
            type: 'build_start',
            groupId,
            prompt,
            requester
        });
    }

    while (iteration < MAX_ITERATIONS) {
        iteration++;
        console.log(`[Build] Iterasi ${iteration}/${MAX_ITERATIONS}`);

        let iterPrompt;
        if (iteration === 1) {
            iterPrompt = buildSystemPrompt(prompt);
        } else {
            const existingFiles = allNewFiles.map(f => {
                const fp = path.join(nemoDir, f);
                return fs.existsSync(fp)
                    ? `\n--- ${f} (${fs.readFileSync(fp,'utf8').split('\n').length} baris) ---\n${fs.readFileSync(fp,'utf8').slice(0,800)}...\n`
                    : '';
            }).join('');

            iterPrompt = buildSystemPrompt(
                `Lanjutkan: ${lastHint}`,
                `File sudah dibuat:\n${existingFiles}\nLanjutkan dari sini, JANGAN mulai ulang!`
            );
        }

        const result = await runOpenCode(iterPrompt, iteration > 1 ? sessionId : null);
        const output = result.stdout;

        // Kumpulkan thinking dari iterasi ini
        const thinking = extractThinking(output);
        if (thinking) {
            allThinking.push(`*Iterasi ${iteration}:*\n${thinking}`);
        }

        // Kirim progress ke grup yang request (setiap iterasi)
        if (groupId && iteration > 1) {
            await sendWebhook({
                type: 'build_progress',
                groupId,
                iteration,
                thinking: thinking.slice(0, 500)
            });
        }

        const newThisIter = detectNewFiles(filesBefore);
        newThisIter.forEach(f => { if (!allNewFiles.includes(f)) allNewFiles.push(f); });

        const signal = parseSignal(output);
        addLog(`[Build] Iterasi ${iteration} signal: ${signal ? signal.status : 'none'}, files baru: ${newThisIter.length}`);

        if (signal?.status === 'done') {
            // AI bilang selesai → break
            if (signal.files) signal.files.forEach(f => { if (!allNewFiles.includes(f)) allNewFiles.push(f); });
            if (signal.usage) finalUsage = signal.usage;
            addLog(`[Build] AI selesai (signal done)`);
            break;

        } else if (signal?.status === 'continue') {
            // AI minta lanjut → tetap iterasi meski sudah ada file
            lastHint = signal.hint || 'lanjutkan';
            if (signal.files_so_far) signal.files_so_far.forEach(f => { if (!allNewFiles.includes(f)) allNewFiles.push(f); });
            addLog(`[Build] AI lanjut: ${lastHint}`);
            continue;

        } else if (signal?.status === 'question') {
            // AI bertanya → jawab otomatis dan lanjut
            questions.push(signal.ask);
            lastHint = `Asumsikan pilihan terbaik dan lanjutkan`;
            addLog(`[Build] AI bertanya: ${signal.ask}`);
            continue;

        } else if (!signal && allNewFiles.length > 0) {
            // Tidak ada signal tapi file sudah ada → AI lupa tulis signal, anggap selesai
            addLog(`[Build] Tidak ada signal tapi file ada → selesai`);
            break;

        } else {
            // Tidak ada signal + tidak ada file → lanjut iterasi
            addLog(`[Build] Tidak ada signal + tidak ada file → lanjut iterasi`);
        }
    }

    const finalFiles = allNewFiles.filter(f => fs.existsSync(path.join(nemoDir, f)));

    if (finalFiles.length === 0) {
        // Kirim log thinking meski gagal
        if (groupId && allThinking.length > 0) {
            await sendWebhook({
                type: 'build_log',
                groupId,
                success: false,
                iterations: iteration,
                thinking: allThinking.join('\n\n─────\n\n').slice(0, 3000)
            });
        }
        return { success: false, iterations: iteration, groupId, message: `Sudah ${iteration} iterasi tapi tidak ada file.` };
    }

    await gitPushAll(finalFiles);

    const features = finalFiles.map(f => f.replace('.js', ''));

    // Bangun usage text
    if (!finalUsage) {
        finalUsage = features.map(f => `• !${f} → gunakan fitur ${f}`).join('\n');
    }

    // Kirim log thinking lengkap ke grup yang request
    if (groupId) {
        await sendWebhook({
            type: 'build_log',
            groupId,
            success: true,
            features,
            iterations: iteration,
            thinking: allThinking.join('\n\n─────\n\n').slice(0, 3000),
            usage: finalUsage,
            requester
        });
    }

    return {
        success: true,
        features,
        feature: features[0],
        iterations: iteration,
        usage: finalUsage,
        thinking: allThinking.join('\n\n').slice(0, 1000),
        questions: questions.length > 0 ? questions : undefined,
        groupId,
        message: `${features.length} fitur berhasil!`
    };
}

// ══════════════════════════════════════════════════════════════
// ENDPOINTS
// ══════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
    res.json({
        status: 'running', version: '4.0',
        service: 'Algojo OpenCode Server',
        ollama: !!OLLAMA_API_KEY, github: !!GITHUB_TOKEN,
        queue: queue.length, processing: isProcessing
    });
});

app.post('/build', async (req, res) => {
    const { prompt, requester, groupId, forceUpdate } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    const queuePos = queue.length + (isProcessing ? 1 : 0);

    // Tolak kalau antrian sudah penuh
    if (queuePos >= 3) {
        return res.json({
            success: false,
            queued: false,
            message: `Server sibuk (${queuePos} antri). Coba lagi nanti!`
        });
    }

    // Kalau ada antrian → balas dulu ke client, proses di background via webhook
    if (queuePos > 0) {
        // Balas HTTP dulu biar client tidak timeout
        res.json({
            success: false,
            queued: true,
            position: queuePos,
            message: `Antrian ke-${queuePos}, estimasi ${queuePos * 3} menit.`
        });
        // Proses di background, kirim hasil via webhook ke bot WA
        addToQueue({ prompt, requester, groupId, forceUpdate })
            .then(result => {
                if (groupId) sendWebhook({ type: 'queue_done', groupId, result });
            })
            .catch(e => {
                if (groupId) sendWebhook({ type: 'queue_error', groupId, error: e.message });
            });
        return;
    }

    // Langsung proses kalau tidak ada antrian
    try {
        const result = await addToQueue({ prompt, requester, groupId, forceUpdate });
        res.json(result);
    } catch(error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/fix', async (req, res) => {
    const { feature, errorLog, manualLog, groupId } = req.body;
    if (!feature) return res.status(400).json({ error: 'feature required' });

    try {
        await setupRepo();
        const featureFile = path.join(BOT_DIR, 'commands', 'nemo', `${feature}.js`);
        if (!fs.existsSync(featureFile)) return res.status(404).json({ error: `${feature}.js tidak ditemukan` });

        const fileContent = fs.readFileSync(featureFile, 'utf8');
        const errorInfo = errorLog || manualLog || 'Unknown error';

        const fixPrompt = buildSystemPrompt(
            `Perbaiki bug pada fitur !${feature}`,
            `File saat ini:\n\`\`\`javascript\n${fileContent}\n\`\`\`\n\nError:\n${errorInfo}\n\nPerbaiki file yang SAMA.`
        );

        let fixed = false;
        let fixThinking = [];

        for (let i = 0; i < 3; i++) {
            const result = await runOpenCode(fixPrompt);
            const thinking = extractThinking(result.stdout);
            if (thinking) fixThinking.push(`Fix iterasi ${i+1}:\n${thinking}`);
            if (parseSignal(result.stdout)?.status === 'done' || fs.existsSync(featureFile)) {
                fixed = true; break;
            }
        }

        if (!fixed) return res.json({ success: false, message: 'Gagal fix setelah 3x' });

        await gitPushAll([`${feature}.js`], true);

        // Kirim log fix ke grup
        if (groupId) {
            await sendWebhook({
                type: 'fix_log',
                groupId,
                feature,
                thinking: fixThinking.join('\n\n').slice(0, 2000)
            });
        }

        res.json({ success: true, feature });
    } catch(error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/queue', (req, res) => {
    res.json({ queue: queue.length, processing: isProcessing, total: queue.length + (isProcessing ? 1 : 0) });
});

// ── Logs (polling tiap 10 detik dari luar) ───────────────────
app.get('/logs', (req, res) => {
    const since = parseInt(req.query.since) || 0;
    const logs = buildLogs.slice(since);
    res.json({ logs, total: buildLogs.length, processing: isProcessing });
});

app.get('/features', async (req, res) => {
    try {
        await setupRepo();
        const nemoDir = path.join(BOT_DIR, 'commands', 'nemo');
        const files = fs.existsSync(nemoDir)
            ? fs.readdirSync(nemoDir).filter(f => f.endsWith('.js')).map(f => f.replace('.js',''))
            : [];
        res.json({ features: files, count: files.length });
    } catch(error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🤖 Algojo OpenCode Server v4 — port ${PORT}`);
    console.log(`🔑 Ollama: ${OLLAMA_API_KEY ? 'OK' : 'NOT SET'} | GitHub: ${GITHUB_TOKEN ? 'OK' : 'NOT SET'}`);
    console.log(`🌐 Webhook: ${BOT_WEBHOOK_URL || 'NOT SET'}`);
});
