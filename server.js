import express from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import cors from 'cors';

const app  = express();
const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 500);

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '1mb' }));

// Multer: save each uploaded file using its fieldname as filename inside a per-request tmpdir
const storage = multer.diskStorage({
  destination(req, file, cb) {
    if (!req._tmpDir) {
      req._tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-'));
    }
    cb(null, req._tmpDir);
  },
  filename(req, file, cb) {
    // Use the field name as the file name so FFmpeg args can reference it directly
    cb(null, file.fieldname);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
});

// Helper: resolve bare filenames in FFmpeg args to absolute paths inside tmpDir
function resolveArgs(args, tmpDir, outputName) {
  return args.map(arg => {
    if (typeof arg !== 'string') return String(arg);
    const candidate = path.join(tmpDir, arg);
    if (fs.existsSync(candidate)) return candidate;
    if (arg === outputName) return candidate;
    return arg;
  });
}

// ── Main render endpoint ──────────────────────────────────────────────────────
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

    console.log('[render/reel] ffmpeg', resolvedArgs.join(' ').slice(0, 300));

    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', ['-y', ...resolvedArgs], { cwd: tmpDir });
      let stderr = '';
      ff.stderr.on('data', d => { stderr += d.toString(); });
      ff.on('error', reject);
      ff.on('close', code => {
        if (code !== 0) {
          reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-2000)}`));
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
    console.error('[render/reel error]', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.listen(PORT, () => {
  console.log(`FFmpeg render server listening on port ${PORT}`);
  console.log(`  CORS origin : ${CORS_ORIGIN}`);
  console.log(`  Max file    : ${MAX_FILE_MB} MB`);
});
