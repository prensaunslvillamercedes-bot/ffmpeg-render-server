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

app.use(cors()); // Allow all origins
app.use(express.json({ limit: '1mb' }));

const storage = multer.diskStorage({
  destination(req, file, cb) {
    if (!req._tmpDir) {
      req._tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-'));
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

app.post('/render/reel', upload.any(), async (req, res) => {
  const tmpDir = req._tmpDir;
  if (!tmpDir) return res.status(400).json({ error: 'No files received' });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  };

  try {
    const args       = JSON.parse(req.body?.args || '[]');
    const outputName = String(req.body?.outputName || 'output.mp4');
    const outputPath = path.join(tmpDir, outputName);

    const resolvedArgs = resolveArgs(args, tmpDir, outputName);

    console.log('[render/reel] ffmpeg', resolvedArgs.join(' ').slice(0, 400));

    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', ['-y', '-threads', '2', ...resolvedArgs], { cwd: tmpDir });

      let stderr = '';
      ff.stderr.on('data', d => {
        const chunk = d.toString();
        stderr += chunk;
        if (stderr.length > 8000) stderr = '…' + stderr.slice(-7500);
      });

      ff.on('error', reject);
      ff.on('close', code => {
        if (code !== 0) {
          reject(new Error(`FFmpeg error (code ${code}): ${stderr.slice(-1500)}`));
        } else {
          resolve();
        }
      });
    });

    if (!fs.existsSync(outputPath)) {
      throw new Error('FFmpeg no generó el archivo de salida');
    }

    const stat = fs.statSync(outputPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Content-Disposition', `attachment; filename="${outputName}"`);
    res.setHeader('Cache-Control', 'no-store');

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('finish', () => setTimeout(cleanup, 2000));
    stream.on('error', () => { cleanup(); res.end(); });

  } catch (err) {
    cleanup();
    console.error('[render/reel error]', err.message.slice(0, 500));
    if (!res.headersSent) {
      res.status(500).json({ error: err.message.slice(0, 500) });
    }
  }
});

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

process.on('uncaughtException', err => console.error('[uncaughtException]', err.message));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

app.listen(PORT, () => {
  console.log(`FFmpeg render server on port ${PORT}`);
});
