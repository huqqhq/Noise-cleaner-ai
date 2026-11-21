import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { verifyActiveSubscriber } from './src/server/authGate.ts';
import {
  processNoiseRemoval,
  type AudioExportFormat,
  type IsolationMode,
} from './src/server/denoiseEngine.ts';

const PORT = Number(process.env.PORT || 3000);
const TEMP_ROOT = path.join(os.tmpdir(), 'noiser-remover-ai-jobs');
const UPLOAD_DIR = path.join(TEMP_ROOT, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

interface StoredJob {
  jobId: string;
  token: string;
  uid: string;
  outputPath: string;
  outputFileName: string;
  mimeType: string;
  jobDir: string;
  createdAt: number;
}

const jobStore = new Map<string, StoredJob>();

// Automatic cleanup of processed temporary files older than 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [jobId, job] of jobStore.entries()) {
    if (job.createdAt < cutoff) {
      jobStore.delete(jobId);
      fsp.rm(job.jobDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}, 5 * 60 * 1000).unref();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12);
    const unique = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
    cb(null, unique);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 150 * 1024 * 1024, // 150 MB max audio/video upload
  },
});

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Protected AI Voice Isolation & Noise Removal Endpoint
  app.post('/api/denoise', (req, res) => {
    upload.single('file')(req, res, async (multerErr) => {
      if (multerErr) {
        const msg =
          multerErr instanceof multer.MulterError && multerErr.code === 'LIMIT_FILE_SIZE'
            ? 'File size exceeds 150 MB limit. Please upload a smaller clip.'
            : multerErr instanceof Error
              ? multerErr.message
              : 'File upload failed.';
        return res.status(400).json({ error: msg });
      }

      const uploadedFile = req.file;

      try {
        const authHeader = req.headers.authorization || '';
        const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

        let subscriber;
        try {
          subscriber = await verifyActiveSubscriber(idToken);
        } catch (err) {
          const code = err instanceof Error ? err.message : 'SUBSCRIPTION_REQUIRED';
          const messageMap: Record<string, string> = {
            AUTH_REQUIRED: 'Google sign-in is required before processing media.',
            INVALID_TOKEN: 'Session expired. Please sign in with Google again.',
            UNVERIFIED_ACCOUNT: 'A verified Google email account is required.',
            ACCOUNT_BANNED:
              'Your account has been permanently blocked after 2 revocations. You can no longer submit UTRs or use this service.',
            SUBSCRIPTION_REVOKED:
              'Your subscription was revoked by the administrator. Please submit a new valid UTR after paying ₹49.',
            SUBSCRIPTION_REQUIRED:
              'Active ₹49 monthly plan required. Please pay via PhonePe/Paytm and submit your UTR first.',
            SUBSCRIPTION_CHECK_FAILED:
              'Could not verify subscription status right now. Please refresh and try again.',
          };
          if (uploadedFile) {
            await fsp.unlink(uploadedFile.path).catch(() => undefined);
          }
          return res.status(403).json({
            error: messageMap[code] || 'Active monthly subscription required.',
            code,
          });
        }

        if (!uploadedFile) {
          return res.status(400).json({ error: 'Please upload an audio or video file first.' });
        }

        const rawMode = String(req.body?.mode || 'balanced');
        const mode: IsolationMode =
          rawMode === 'maximum' || rawMode === 'natural' ? rawMode : 'balanced';

        const rawFormat = String(req.body?.audioFormat || 'wav');
        const audioFormat: AudioExportFormat = rawFormat === 'mp3' ? 'mp3' : 'wav';

        const parsedNoiseStrength = Number(req.body?.noiseStrength);
        const noiseStrength = Number.isFinite(parsedNoiseStrength)
          ? Math.max(20, Math.min(100, Math.round(parsedNoiseStrength)))
          : undefined;
        const enhanceVoice =
          req.body?.enhanceVoice === undefined
            ? undefined
            : String(req.body.enhanceVoice) !== 'false' && String(req.body.enhanceVoice) !== '0';
        const parsedEnhanceStrength = Number(req.body?.enhanceStrength);
        const enhanceStrength = Number.isFinite(parsedEnhanceStrength)
          ? Math.max(0, Math.min(100, Math.round(parsedEnhanceStrength)))
          : undefined;
        const removeEcho =
          req.body?.removeEcho === undefined
            ? undefined
            : String(req.body.removeEcho) !== 'false' && String(req.body.removeEcho) !== '0';
        const normalizeLoudness =
          req.body?.normalizeLoudness === undefined
            ? undefined
            : String(req.body.normalizeLoudness) !== 'false' &&
              String(req.body.normalizeLoudness) !== '0';
        const parsedVoiceVolume = Number(req.body?.voiceVolume);
        const voiceVolume = Number.isFinite(parsedVoiceVolume)
          ? Math.max(50, Math.min(200, Math.round(parsedVoiceVolume)))
          : undefined;

        const jobId = `job_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        const accessToken = crypto.randomBytes(24).toString('hex');
        const jobDir = path.join(TEMP_ROOT, jobId);
        await fsp.mkdir(jobDir, { recursive: true });

        const result = await processNoiseRemoval(
          uploadedFile.path,
          uploadedFile.originalname || 'recording',
          jobDir,
          mode,
          audioFormat,
          {
            noiseStrength,
            enhanceVoice,
            enhanceStrength,
            removeEcho,
            normalizeLoudness,
            voiceVolume,
          },
        );

        await fsp.unlink(uploadedFile.path).catch(() => undefined);

        jobStore.set(jobId, {
          jobId,
          token: accessToken,
          uid: subscriber.uid,
          outputPath: result.outputPath,
          outputFileName: result.outputFileName,
          mimeType: result.mimeType,
          jobDir,
          createdAt: Date.now(),
        });

        const baseUrl = `/api/media/${encodeURIComponent(jobId)}?token=${encodeURIComponent(accessToken)}`;

        return res.json({
          jobId,
          mediaType: result.mediaType,
          outputFileName: result.outputFileName,
          mimeType: result.mimeType,
          durationSec: result.durationSec,
          speechDurationSec: result.speechDurationSec,
          noiseReductionDb: result.noiseReductionDb,
          speechPreservationPct: result.speechPreservationPct,
          originalPeaks: result.originalPeaks,
          cleanedPeaks: result.cleanedPeaks,
          streamUrl: baseUrl,
          downloadUrl: `${baseUrl}&download=1`,
        });
      } catch (error) {
        if (uploadedFile) {
          await fsp.unlink(uploadedFile.path).catch(() => undefined);
        }
        console.error('Noise removal error:', error);
        const rawMsg =
          error instanceof Error ? error.message : 'Failed to process audio/video file.';
        const friendlyMsg = rawMsg.includes('Command failed: ffmpeg')
          ? 'Could not decode this media file. Please verify it contains a valid audio track and try MP3, WAV, M4A, or MP4.'
          : rawMsg;
        return res.status(500).json({ error: friendlyMsg });
      }
    });
  });

  // Stream or download cleaned media
  app.get('/api/media/:jobId', async (req, res) => {
    const jobId = req.params.jobId;
    const token = String(req.query.token || '');
    const isDownload = req.query.download === '1';

    const job = jobStore.get(jobId);
    if (!job || !token || job.token !== token) {
      return res.status(403).json({ error: 'Unauthorized or expired cleaned media link.' });
    }

    if (!fs.existsSync(job.outputPath)) {
      jobStore.delete(jobId);
      return res.status(404).json({ error: 'Processed file has expired. Please run again.' });
    }

    const stat = await fsp.stat(job.outputPath);
    const totalSize = stat.size;

    res.setHeader('Content-Type', job.mimeType);
    res.setHeader('Accept-Ranges', 'bytes');

    if (isDownload) {
      const safeName = job.outputFileName.replace(/["\r\n]/g, '');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      res.setHeader('Content-Length', String(totalSize));
      fs.createReadStream(job.outputPath).pipe(res);
      return;
    }

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      res.setHeader('Content-Length', String(chunkSize));
      fs.createReadStream(job.outputPath, { start, end }).pipe(res);
      return;
    }

    res.setHeader('Content-Length', String(totalSize));
    fs.createReadStream(job.outputPath).pipe(res);
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, allowedHosts: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Noise Remover AI server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
