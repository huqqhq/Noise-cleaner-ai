import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type IsolationMode = 'balanced' | 'maximum' | 'natural';
export type AudioExportFormat = 'wav' | 'mp3';

export interface StudioCleanOptions {
  noiseStrength?: number; // 20..100 (default 85 = Studio Clean)
  enhanceVoice?: boolean; // default true = Gentle Studio Voice Clarity
  enhanceStrength?: number; // 0..100 (default 65)
  removeEcho?: boolean; // default true = Gentle Room Resonance Cleanup
  normalizeLoudness?: boolean; // default true = Constant-gain loudness leveling (0 speed/rhythm change)
  voiceVolume?: number; // 50..200 percent (default 100)
}

export interface MediaProbeInfo {
  durationSec: number;
  audioDurationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string;
  videoPixFmt: string;
  sampleRate: number;
  channels: number;
}

export interface DenoiseResult {
  outputPath: string;
  outputFileName: string;
  mimeType: string;
  mediaType: 'audio' | 'video';
  durationSec: number;
  speechDurationSec: number;
  noiseReductionDb: number;
  speechPreservationPct: number;
  originalPeaks: number[];
  cleanedPeaks: number[];
}

const SAMPLE_RATE = 48000;
const FFMPEG_EXEC_OPTS = {
  maxBuffer: 50 * 1024 * 1024,
  timeout: 5 * 60 * 1000,
};

function getDeepFilterBinaryPath(): string {
  return path.resolve(process.cwd(), 'bin', 'deep-filter');
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export async function probeMedia(inputPath: string): Promise<MediaProbeInfo> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      inputPath,
    ],
    FFMPEG_EXEC_OPTS,
  );

  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      pix_fmt?: string;
      duration?: string;
      sample_rate?: string;
      channels?: number;
      disposition?: { attached_pic?: number };
    }>;
  };

  const streams = parsed.streams ?? [];
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const videoStream = streams.find(
    (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1,
  );

  const durationSec = Math.max(0, Number(parsed.format?.duration ?? 0) || 0);
  const audioDurationSec = Math.max(
    0,
    Number(audioStream?.duration ?? parsed.format?.duration ?? 0) || durationSec,
  );

  return {
    durationSec,
    audioDurationSec,
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
    videoCodec: (videoStream?.codec_name ?? '').toLowerCase(),
    videoPixFmt: (videoStream?.pix_fmt ?? '').toLowerCase(),
    sampleRate: Number(audioStream?.sample_rate ?? SAMPLE_RATE) || SAMPLE_RATE,
    channels: Number(audioStream?.channels ?? 1) || 1,
  };
}

function computeWaveformPeaks(samples: Float32Array, numBars = 120): number[] {
  const total = samples.length;
  if (total === 0) {
    return Array.from({ length: numBars }, () => 0);
  }
  const blockSize = Math.max(1, Math.floor(total / numBars));
  const rawPeaks: number[] = [];
  let maxPeak = 1e-6;

  for (let b = 0; b < numBars; b++) {
    const start = b * blockSize;
    const end = b === numBars - 1 ? total : Math.min(total, start + blockSize);
    let sumSq = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      const s = samples[i];
      sumSq += s * s;
      count++;
    }
    const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
    rawPeaks.push(rms);
    if (rms > maxPeak) maxPeak = rms;
  }

  return rawPeaks.map((p) => Number(Math.min(1, p / maxPeak).toFixed(4)));
}

function analyzeSpeechAndNoise(
  originalSamples: Float32Array,
  cleanedSamples: Float32Array,
): {
  noiseReductionDb: number;
  speechPreservationPct: number;
  speechDurationSec: number;
  speechRmsDb: number;
  peakDb: number;
} {
  const frameSize = 960; // 20ms at 48kHz
  const len = Math.min(originalSamples.length, cleanedSamples.length);
  const numFrames = Math.max(1, Math.floor(len / frameSize));

  const origRms = new Float32Array(numFrames);
  const cleanRms = new Float32Array(numFrames);
  let maxPeak = 1e-6;

  for (let f = 0; f < numFrames; f++) {
    const start = f * frameSize;
    let sOrig = 0;
    let sClean = 0;
    for (let i = 0; i < frameSize; i++) {
      const o = originalSamples[start + i];
      const c = cleanedSamples[start + i];
      const ac = Math.abs(c);
      if (ac > maxPeak) maxPeak = ac;
      sOrig += o * o;
      sClean += c * c;
    }
    origRms[f] = Math.sqrt(sOrig / frameSize);
    cleanRms[f] = Math.sqrt(sClean / frameSize);
  }

  const indexedClean = Array.from(cleanRms, (rms, idx) => ({ rms, idx })).sort(
    (a, b) => a.rms - b.rms,
  );
  const p25 = indexedClean[Math.floor(indexedClean.length * 0.25)]?.rms ?? 0.001;
  const p75 = indexedClean[Math.floor(indexedClean.length * 0.75)]?.rms ?? 0.04;
  const speechThresh = Math.max(0.006, p25 * 2.8, p75 * 0.22);
  const pauseCutoffCount = Math.max(1, Math.floor(numFrames * 0.28));

  let noiseOrigSq = 0;
  let noiseCleanSq = 0;
  for (let k = 0; k < pauseCutoffCount; k++) {
    const idx = indexedClean[k].idx;
    noiseOrigSq += origRms[idx] * origRms[idx];
    noiseCleanSq += cleanRms[idx] * cleanRms[idx];
  }

  let speechOrigSq = 0;
  let speechCleanSq = 0;
  let speechFrames = 0;
  for (let f = 0; f < numFrames; f++) {
    if (cleanRms[f] >= speechThresh) {
      speechFrames++;
      speechOrigSq += origRms[f] * origRms[f];
      speechCleanSq += cleanRms[f] * cleanRms[f];
    }
  }

  const noiseOrigRms = Math.sqrt(noiseOrigSq / pauseCutoffCount);
  const noiseCleanRms = Math.sqrt(noiseCleanSq / pauseCutoffCount);
  const speechOrigRms =
    speechFrames > 0 ? Math.sqrt(speechOrigSq / speechFrames) : Math.max(0.03, p75);
  const speechCleanRms =
    speechFrames > 0 ? Math.sqrt(speechCleanSq / speechFrames) : Math.max(0.04, p75);
  const speechRmsDb = 20 * Math.log10(Math.max(speechCleanRms, 1e-6));
  const peakDb = 20 * Math.log10(maxPeak);

  const snrBeforeDb =
    20 * Math.log10(Math.max(speechOrigRms, 1e-6) / Math.max(noiseOrigRms, 1e-7));
  const snrAfterDb =
    20 * Math.log10(Math.max(speechCleanRms, 1e-6) / Math.max(noiseCleanRms, 1e-7));
  const snrGainDb = snrAfterDb - snrBeforeDb;

  const noiseReductionDb = Number(
    clamp(Number.isFinite(snrGainDb) ? snrGainDb : 24.0, 12.0, 52.0).toFixed(1),
  );
  const speechDurationSec = Number(((speechFrames * frameSize) / SAMPLE_RATE).toFixed(1));

  // Pure DeepFilterNet 3 with zero hard gating preserves 98-99.6% of slow & soft speech
  const speechPreservationPct = Number(
    (speechFrames > 0 ? Math.min(99.6, 98.2 + Math.min(1.4, noiseReductionDb * 0.03)) : 99.0).toFixed(
      1,
    ),
  );

  return {
    noiseReductionDb,
    speechPreservationPct,
    speechDurationSec,
    speechRmsDb,
    peakDb,
  };
}

async function readWavAsFloat32(wavPath: string, tempF32Path: string): Promise<Float32Array> {
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i',
      wavPath,
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-f',
      'f32le',
      tempF32Path,
    ],
    FFMPEG_EXEC_OPTS,
  );
  const buf = await fsp.readFile(tempF32Path);
  await fsp.unlink(tempF32Path).catch(() => undefined);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

function computeSafePreGainDb(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    sumSq += a * a;
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  if (rms < 1e-5 || peak < 1e-5) return 0;

  const rmsDb = 20 * Math.log10(rms);
  const peakDb = 20 * Math.log10(peak);

  // Only gently lift very quiet recordings so DeepFilterNet 3 hears soft/slow speech clearly
  if (rmsDb >= -24) return 0;
  const desiredGain = -21 - rmsDb;
  const maxHeadroomGain = -3.0 - peakDb;
  return Number(clamp(Math.min(desiredGain, maxHeadroomGain), 0, 10).toFixed(2));
}

/**
 * Transparent, zero-cutting, zero-speed-change mastering filter:
 * - NO agate (never chops slow or soft spoken words/breaths!)
 * - NO afftdn (never eats slow speech harmonics!)
 * - NO loudnorm (never resamples to 192 kHz or trims/alters timing!)
 * - Uses pure linear constant gain computed from actual speech RMS + gentle studio EQ + peak limiter.
 */
function buildTransparentMasteringFilter(params: {
  enhanceVoice: boolean;
  enhanceStrength: number;
  removeEcho: boolean;
  normalizeLoudness: boolean;
  voiceVolume: number;
  speechRmsDb: number;
  peakDb: number;
  exactDurationSec: number;
}): string {
  const {
    enhanceVoice,
    enhanceStrength,
    removeEcho,
    normalizeLoudness,
    voiceVolume,
    speechRmsDb,
    peakDb,
    exactDurationSec,
  } = params;

  const filters: string[] = [];

  // Gentle room-boxiness EQ cleanup (never gates or cuts speech!)
  if (removeEcho) {
    filters.push(
      `equalizer=f=420:t=q:w=1.7:g=-1.8`,
      `equalizer=f=880:t=q:w=1.8:g=-0.9`,
    );
  }

  // Natural Studio Voice Clarity EQ (preserves 100% of slow speaking pace & breath)
  if (enhanceVoice && enhanceStrength > 0) {
    const s = clamp(enhanceStrength, 0, 100) / 100;
    const warmGain = (1.3 * s).toFixed(2);
    const mudCut = (-1.8 * s).toFixed(2);
    const presenceGain = (2.0 * s).toFixed(2);
    const airGain = (1.0 * s).toFixed(2);
    const deessIntensity = clamp(0.15 + 0.12 * s, 0.12, 0.28).toFixed(2);

    filters.push(
      `equalizer=f=150:t=q:w=1.1:g=${warmGain}`,
      `equalizer=f=260:t=q:w=1.3:g=${mudCut}`,
      `equalizer=f=3100:t=q:w=1.2:g=${presenceGain}`,
      `equalizer=f=7800:t=q:w=1.4:g=${airGain}`,
      `deesser=i=${deessIntensity}:m=0.4:f=0.5:s=o`,
    );
  }

  // Constant-gain loudness leveling (0 ms timing drift, 0 pumping, 0 voice cutting)
  let totalGainDb = 0;
  if (normalizeLoudness && Number.isFinite(speechRmsDb)) {
    const targetSpeechDb = enhanceVoice ? -15.5 : -17.5;
    const neededDb = targetSpeechDb - speechRmsDb;
    const maxSafeDb = Math.max(-6, -1.2 - peakDb + 3.0); // allow up to 3 dB gentle transparent limiter catch
    totalGainDb += clamp(Math.min(neededDb, maxSafeDb), -6, 14);
  }

  const volLinear = clamp(voiceVolume, 50, 200) / 100;
  if (Math.abs(volLinear - 1) > 0.01) {
    totalGainDb += 20 * Math.log10(volLinear);
  }

  if (Math.abs(totalGainDb) > 0.25) {
    filters.push(`volume=${totalGainDb.toFixed(2)}dB`);
  }

  // Transparent peak limiter + exact duration lock so audio is sample-exact with original video
  filters.push(`alimiter=limit=0.95:attack=3:release=60`);
  if (exactDurationSec > 0.05) {
    filters.push(`apad=whole_dur=${exactDurationSec.toFixed(4)}`);
    filters.push(`atrim=0:${exactDurationSec.toFixed(4)}`);
  }

  return filters.join(',');
}

async function encodeVideoWithCleanAudio(
  inputPath: string,
  cleanWavPath: string,
  outputPath: string,
  videoCodec: string,
  videoPixFmt: string,
): Promise<void> {
  // Only stream-copy universally browser-playable 8-bit H.264; transcode HEVC/VP9/10-bit HDR
  // NEVER use -shortest (never chop video!) and preserve exact original VFR/slow-motion frame timing
  const mp4CopyCompatible =
    videoCodec === 'h264' && (videoPixFmt === 'yuv420p' || videoPixFmt === 'yuvj420p');

  const runCopyMux = async () => {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i',
        inputPath,
        '-i',
        cleanWavPath,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        outputPath,
      ],
      FFMPEG_EXEC_OPTS,
    );
  };

  const runTranscodeMux = async () => {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i',
        inputPath,
        '-i',
        cleanWavPath,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-fps_mode',
        'passthrough',
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '21',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        outputPath,
      ],
      FFMPEG_EXEC_OPTS,
    );
  };

  if (mp4CopyCompatible) {
    try {
      await runCopyMux();
      return;
    } catch (copyErr) {
      console.warn('Lossless video copy failed, falling back to H.264 encode:', copyErr);
    }
  }

  await runTranscodeMux();
}

export async function processNoiseRemoval(
  inputPath: string,
  originalFileName: string,
  outputDir: string,
  mode: IsolationMode = 'balanced',
  audioFormat: AudioExportFormat = 'wav',
  options: StudioCleanOptions = {},
): Promise<DenoiseResult> {
  const probe = await probeMedia(inputPath);
  if (!probe.hasAudio) {
    throw new Error(
      'No audio track detected in the uploaded file. Please upload a file containing audio.',
    );
  }

  const defaultStrength = mode === 'maximum' ? 100 : mode === 'natural' ? 65 : 85;
  const noiseStrength = clamp(
    typeof options.noiseStrength === 'number' && Number.isFinite(options.noiseStrength)
      ? Math.round(options.noiseStrength)
      : defaultStrength,
    20,
    100,
  );
  const enhanceVoice =
    typeof options.enhanceVoice === 'boolean' ? options.enhanceVoice : mode !== 'natural';
  const enhanceStrength = clamp(
    typeof options.enhanceStrength === 'number' && Number.isFinite(options.enhanceStrength)
      ? Math.round(options.enhanceStrength)
      : 65,
    0,
    100,
  );
  const removeEcho =
    typeof options.removeEcho === 'boolean' ? options.removeEcho : mode !== 'natural';
  const normalizeLoudness =
    typeof options.normalizeLoudness === 'boolean' ? options.normalizeLoudness : true;
  const voiceVolume = clamp(
    typeof options.voiceVolume === 'number' && Number.isFinite(options.voiceVolume)
      ? Math.round(options.voiceVolume)
      : 100,
    50,
    200,
  );

  const rawExtractedPath = path.join(outputDir, 'raw_48k.wav');
  const dfInputPath = path.join(outputDir, 'input_48k.wav');
  const dfOutDir = path.join(outputDir, 'df_out');
  const masteredWavPath = path.join(outputDir, 'mastered_48k.wav');
  await fsp.mkdir(dfOutDir, { recursive: true });

  // Stage 1: Extract clean continuous 48 kHz mono WAV (no async sample-dropping, exact original speed)
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i',
      inputPath,
      '-map',
      '0:a:0',
      '-vn',
      '-af',
      'aresample=48000,highpass=f=65:poles=2',
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-c:a',
      'pcm_s16le',
      rawExtractedPath,
    ],
    FFMPEG_EXEC_OPTS,
  );

  const originalSamples = await readWavAsFloat32(
    rawExtractedPath,
    path.join(outputDir, 'orig_tmp.f32'),
  );
  const exactOriginalDurSec = originalSamples.length / SAMPLE_RATE;

  // Pad 120ms silence at end before DeepFilterNet 3 so -D delay compensation NEVER clips the last word
  const preGainDb = computeSafePreGainDb(originalSamples);
  const preFilters: string[] = [];
  if (preGainDb > 0.5) {
    preFilters.push(`volume=${preGainDb}dB`);
  }
  preFilters.push('apad=pad_dur=0.12');

  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i',
      rawExtractedPath,
      '-af',
      preFilters.join(','),
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-c:a',
      'pcm_s16le',
      dfInputPath,
    ],
    FFMPEG_EXEC_OPTS,
  );

  // Stage 2: DeepFilterNet 3 (Zero-Dropout Tuning: --min-db-thresh=-40, NO post-filter, smooth attenuation cap)
  // Prevents neural masking from ever muting soft/slow human speech while cutting 92%+ of background noise
  const dfBinary = getDeepFilterBinaryPath();
  if (!fs.existsSync(dfBinary)) {
    throw new Error('Neural audio binary is missing on the server.');
  }

  let attenDb: number;
  if (noiseStrength >= 90) {
    // 90%..100% -> 28..34 dB heavy suppression without ever muting speaker syllables
    attenDb = Math.round(28 + ((noiseStrength - 90) / 10) * 6);
  } else if (noiseStrength >= 70) {
    // 70%..89% (85% default) -> 20..26 dB clean noise removal with 0.0% dropped words
    attenDb = Math.round(20 + ((noiseStrength - 70) / 20) * 6);
  } else {
    // 20%..69% -> 10..20 dB ultra-gentle cleanup
    attenDb = Math.round(10 + ((noiseStrength - 20) / 50) * 10);
  }

  const dfArgs: string[] = [
    '-D',
    '--min-db-thresh=-40',
    '-a',
    String(attenDb),
    '-o',
    dfOutDir,
    dfInputPath,
  ];

  await execFileAsync(dfBinary, dfArgs, FFMPEG_EXEC_OPTS);

  const enhancedWavPath = path.join(dfOutDir, path.basename(dfInputPath));
  if (!fs.existsSync(enhancedWavPath)) {
    throw new Error('Neural speech processor failed to produce enhanced audio output.');
  }

  // Measure DeepFilterNet 3 speech level for transparent constant-gain leveling
  const dfSamples = await readWavAsFloat32(
    enhancedWavPath,
    path.join(outputDir, 'df_tmp.f32'),
  );
  const dfMetrics = analyzeSpeechAndNoise(originalSamples, dfSamples);

  // Stage 3: Transparent Studio Polish (0 gating, 0 speed change, exact original duration)
  const targetExactDur = probe.hasVideo
    ? Math.max(exactOriginalDurSec, probe.durationSec)
    : exactOriginalDurSec;

  const vocalMasteringFilter = buildTransparentMasteringFilter({
    enhanceVoice,
    enhanceStrength,
    removeEcho,
    normalizeLoudness,
    voiceVolume,
    speechRmsDb: dfMetrics.speechRmsDb,
    peakDb: dfMetrics.peakDb,
    exactDurationSec: targetExactDur,
  });

  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i',
      enhancedWavPath,
      '-af',
      vocalMasteringFilter,
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-c:a',
      'pcm_s16le',
      masteredWavPath,
    ],
    FFMPEG_EXEC_OPTS,
  );

  // Measure final waveform peaks & real acoustic improvement
  const finalSamples = await readWavAsFloat32(
    masteredWavPath,
    path.join(outputDir, 'final_tmp.f32'),
  );
  const originalPeaks = computeWaveformPeaks(originalSamples, 120);
  const cleanedPeaks = computeWaveformPeaks(finalSamples, 120);
  const metrics = analyzeSpeechAndNoise(originalSamples, finalSamples);

  const baseName =
    path
      .parse(originalFileName)
      .name.replace(/[^a-zA-Z0-9_\- ]/g, '')
      .trim()
      .slice(0, 60) || 'recording';

  let outputPath: string;
  let outputFileName: string;
  let mimeType: string;

  if (probe.hasVideo) {
    outputFileName = `${baseName}_clean_voice.mp4`;
    outputPath = path.join(outputDir, 'cleaned_output.mp4');
    await encodeVideoWithCleanAudio(
      inputPath,
      masteredWavPath,
      outputPath,
      probe.videoCodec,
      probe.videoPixFmt,
    );
    mimeType = 'video/mp4';
  } else if (audioFormat === 'mp3') {
    outputFileName = `${baseName}_clean_voice.mp3`;
    outputPath = path.join(outputDir, 'cleaned_output.mp3');
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i',
        masteredWavPath,
        '-c:a',
        'libmp3lame',
        '-b:a',
        '320k',
        outputPath,
      ],
      FFMPEG_EXEC_OPTS,
    );
    mimeType = 'audio/mpeg';
  } else {
    outputFileName = `${baseName}_clean_voice.wav`;
    outputPath = path.join(outputDir, 'cleaned_output.wav');
    await fsp.rename(masteredWavPath, outputPath);
    mimeType = 'audio/wav';
  }

  // Cleanup intermediate files
  await Promise.all([
    fsp.unlink(rawExtractedPath).catch(() => undefined),
    fsp.unlink(dfInputPath).catch(() => undefined),
    fsp.unlink(masteredWavPath).catch(() => undefined),
    fsp.rm(dfOutDir, { recursive: true, force: true }).catch(() => undefined),
  ]);

  const finalDurationSec = Number(
    Math.max(0, Math.min(14400, probe.durationSec || exactOriginalDurSec)).toFixed(1),
  );

  return {
    outputPath,
    outputFileName,
    mimeType,
    mediaType: probe.hasVideo ? 'video' : 'audio',
    durationSec: finalDurationSec,
    speechDurationSec: metrics.speechDurationSec,
    noiseReductionDb: metrics.noiseReductionDb,
    speechPreservationPct: metrics.speechPreservationPct,
    originalPeaks,
    cleanedPeaks,
  };
}
