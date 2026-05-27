import express from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import cors from 'cors';

const app  = express();
const PORT = process.env.PORT || 3000;
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 500);

// Use /var/tmp (disk-backed) instead of /tmp (RAM-backed tmpfs on many cloud hosts).
const TMPBASE = fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const storage = multer.diskStorage({
  destination(req, file, cb) {
    if (!req._tmpDir) {
      req._tmpDir = fs.mkdtempSync(path.join(TMPBASE, 'reel-'));
    }
    cb(null, req._tmpDir);
  },
  filename(req, file, cb) {
    cb(null, file.fieldname);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
});

function resolveArgs(args, tmpDir, outputName) {
  return args.map(arg => {
    if (typeof arg !== 'string') return String(arg);
    const candidate = path.join(tmpDir, arg);
    if (fs.existsSync(candidate)) return candidate;
    if (arg === outputName) return candidate;
    return arg;
  });
}

// Only one FFmpeg at a time — free tier has 0.1 CPU, two concurrent encodes starve each other.
let ffmpegRunning = false;

app.post('/render/reel', upload.any(), async (req, res) => {
  const tmpDir = req._tmpDir;
  if (!tmpDir) return res.status(400).json({ error: 'No files received' });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  };

  if (ffmpegRunning) {
    cleanup();
    return res.status(503).json({ error: 'Servidor ocupado procesando otro video. Reintentá en un minuto.' });
  }

  ffmpegRunning = true;

  try {
    const args       = JSON.parse(req.body?.args || '[]');
    const outputName = String(req.body?.outputName || 'output.mp4');
    const resolvedArgs = resolveArgs(args, tmpDir, outputName);

    console.log('[render/reel] tmpDir:', tmpDir, '| ffmpeg', resolvedArgs.join(' ').slice(0, 400));

    // Send headers immediately — FFmpeg streams output via pipe:1 directly to the client.
    // This prevents Render's proxy from timing out while waiting for FFmpeg to finish.
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${outputName}"`);
    res.setHeader('Cache-Control', 'no-store');

    const ff = spawn('ffmpeg', ['-y', '-threads', '1', ...resolvedArgs], { cwd: tmpDir });

    let stderr = '';
    ff.stderr.on('data', d => {
      const chunk = d.toString();
      stderr += chunk;
      if (stderr.length > 8000) stderr = '…' + stderr.slice(-7500);
    });

    ff.stdout.pipe(res);

    await new Promise((resolve, reject) => {
      ff.on('error', reject);
      ff.on('close', code => {
        if (code !== 0) {
          reject(new Error(`FFmpeg error (code ${code}): ${stderr.slice(-1500)}`));
        } else {
          resolve();
        }
      });
    });

    cleanup();
  } catch (err) {
    cleanup();
    console.error('[render/reel error]', err.message.slice(0, 500));
    if (!res.headersSent) {
      res.status(500).json({ error: err.message.slice(0, 500) });
    } else {
      res.destroy();
    }
  } finally {
    ffmpegRunning = false;
  }
});

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime(), tmpbase: TMPBASE, busy: ffmpegRunning }));

process.on('uncaughtException', err => console.error('[uncaughtException]', err.message));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

app.listen(PORT, () => {
  console.log(`FFmpeg render server on port ${PORT}`);
  console.log(`  tmpbase: ${TMPBASE}`);
});
