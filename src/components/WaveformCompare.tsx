import { useEffect, useRef, useState } from 'react';
import { Download, Loader2, Pause, Play, Video, Volume2 } from 'lucide-react';
import type { DenoiseApiResponse } from '../types';
import { exportSyncedCleanVideo } from '../utils/clientDenoiseEngine';

interface WaveformCompareProps {
  originalUrl: string;
  result: DenoiseApiResponse;
}

function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: number[],
  progress: number,
  activeColor: string,
  inactiveColor: string,
) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const count = peaks.length || 1;
  const gap = 2;
  const barWidth = Math.max(2, (rect.width - gap * (count - 1)) / count);
  const centerY = rect.height / 2;
  const maxBarHeight = rect.height * 0.86;

  for (let i = 0; i < count; i++) {
    const x = i * (barWidth + gap);
    const ratio = i / count;
    const amp = Math.max(0.05, peaks[i] ?? 0);
    const barH = Math.max(3, amp * maxBarHeight);
    ctx.fillStyle = ratio <= progress ? activeColor : inactiveColor;
    ctx.beginPath();
    ctx.roundRect(x, centerY - barH / 2, barWidth, barH, 1.5);
    ctx.fill();
  }
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function WaveformCompare({ originalUrl, result }: WaveformCompareProps) {
  const [listenMode, setListenMode] = useState<'clean' | 'original'>('clean');
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(result.durationSec || 0);
  const [exportingVideo, setExportingVideo] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportError, setExportError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const syncedAudioRef = useRef<HTMLAudioElement | null>(null);
  const origCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cleanCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const isSyncedVideo = Boolean(result.mediaType === 'video' && result.isSyncedVideoFallback);
  const cleanAudioTrackUrl = result.cleanedAudioUrl || result.streamUrl;

  // For direct server MP4 video or audio files, swap src cleanly; for synced browser-fallback video, keep video src = originalUrl and lock cleaned audio track
  const activeMediaSrc = isSyncedVideo
    ? originalUrl
    : listenMode === 'clean'
      ? result.streamUrl
      : originalUrl;

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  // Scroll cleaned result + video player smoothly into view as soon as processing finishes
  useEffect(() => {
    setListenMode('clean');
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(result.durationSec || 0);
    setExportError(null);
    const timer = window.setTimeout(() => {
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [result.jobId, result.durationSec]);

  useEffect(() => {
    if (origCanvasRef.current) {
      drawWaveform(
        origCanvasRef.current,
        result.originalPeaks,
        listenMode === 'original' ? progress : 0,
        '#94A3B8',
        'rgba(148, 163, 184, 0.25)',
      );
    }
    if (cleanCanvasRef.current) {
      drawWaveform(
        cleanCanvasRef.current,
        result.cleanedPeaks,
        listenMode === 'clean' ? progress : 0,
        '#F59E0B',
        'rgba(245, 158, 11, 0.26)',
      );
    }
  }, [result.originalPeaks, result.cleanedPeaks, progress, listenMode]);

  // Keep synced cleaned audio muted/unmuted instantaneously when flipping Clean <-> Original in synced video mode
  useEffect(() => {
    if (!isSyncedVideo) return;
    const videoEl = mediaRef.current as HTMLVideoElement | null;
    const audioEl = syncedAudioRef.current;
    if (!videoEl || !audioEl) return;

    videoEl.muted = listenMode === 'clean';
    audioEl.muted = listenMode !== 'clean';
    if (!videoEl.paused) {
      if (Math.abs(audioEl.currentTime - videoEl.currentTime) > 0.12) {
        audioEl.currentTime = videoEl.currentTime;
      }
      audioEl.play().catch(() => undefined);
    }
  }, [isSyncedVideo, listenMode]);

  const handleSwitchMode = (nextMode: 'clean' | 'original') => {
    if (nextMode === listenMode) return;

    if (isSyncedVideo) {
      // Live zero-glitch audio switch without stopping or reloading the video frame!
      setListenMode(nextMode);
      return;
    }

    const el = mediaRef.current;
    const resumeTime = el ? el.currentTime : 0;
    const wasPlaying = Boolean(el && !el.paused);
    setListenMode(nextMode);

    window.setTimeout(() => {
      const target = mediaRef.current;
      if (!target) return;
      const restore = () => {
        if (Number.isFinite(resumeTime) && resumeTime > 0) {
          target.currentTime = Math.min(resumeTime, target.duration || resumeTime);
        }
        if (wasPlaying) {
          target.play().catch(() => undefined);
        }
      };
      if (target.readyState >= 1) {
        restore();
      } else {
        target.addEventListener('loadedmetadata', restore, { once: true });
      }
    }, 40);
  };

  const togglePlay = () => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) {
      el.play().catch(() => undefined);
    } else {
      el.pause();
    }
  };

  const handleSeek = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const el = mediaRef.current;
    if (!el || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const nextTime = clickRatio * duration;
    el.currentTime = nextTime;
    if (isSyncedVideo && syncedAudioRef.current) {
      syncedAudioRef.current.currentTime = nextTime;
    }
    setCurrentTime(nextTime);
  };

  // Sync handlers for browser-fallback video + cleaned audio
  const handleMediaPlay = () => {
    setIsPlaying(true);
    if (isSyncedVideo && mediaRef.current && syncedAudioRef.current) {
      const videoEl = mediaRef.current as HTMLVideoElement;
      const audioEl = syncedAudioRef.current;
      videoEl.muted = listenMode === 'clean';
      audioEl.muted = listenMode !== 'clean';
      audioEl.playbackRate = videoEl.playbackRate;
      audioEl.currentTime = videoEl.currentTime;
      audioEl.play().catch(() => undefined);
    }
  };

  const handleMediaPause = () => {
    setIsPlaying(false);
    if (isSyncedVideo && syncedAudioRef.current) {
      syncedAudioRef.current.pause();
    }
  };

  const handleMediaSeeked = () => {
    if (isSyncedVideo && mediaRef.current && syncedAudioRef.current) {
      syncedAudioRef.current.currentTime = mediaRef.current.currentTime;
    }
  };

  const handleMediaTimeUpdate = (time: number) => {
    setCurrentTime(time);
    if (isSyncedVideo && mediaRef.current && syncedAudioRef.current && !mediaRef.current.paused) {
      const drift = Math.abs(syncedAudioRef.current.currentTime - time);
      if (drift > 0.35) {
        syncedAudioRef.current.currentTime = time;
      }
    }
  };

  const handleDownloadSyncedVideo = async () => {
    setExportingVideo(true);
    setExportProgress(2);
    setExportError(null);
    try {
      const { blob, ext } = await exportSyncedCleanVideo(
        originalUrl,
        cleanAudioTrackUrl,
        (pct) => setExportProgress(pct),
      );
      const url = URL.createObjectURL(blob);
      const base = result.outputFileName.replace(/\.[^.]+$/, '');
      const a = document.createElement('a');
      a.href = url;
      a.download = `${base}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : 'Could not export clean video in this browser.',
      );
    } finally {
      setExportingVideo(false);
      setExportProgress(0);
    }
  };

  return (
    <div
      ref={containerRef}
      className="bg-[#12161E] border border-white/[0.08] rounded-xl p-6 sm:p-8 space-y-6 scroll-mt-24"
    >
      {/* Header + Live A/B Toggle */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-white/[0.08]">
        <div className="space-y-1">
          <p className="text-xs font-medium text-emerald-400">
            {result.mediaType === 'video'
              ? 'Clean Video Ready — AI Noise Removal Complete'
              : 'Studio Voice Isolation Complete'}
          </p>
          <h3 className="text-xl font-bold text-white tracking-tight truncate max-w-xl">
            {result.outputFileName}
          </h3>
        </div>

        <div className="flex items-center gap-1 p-1 bg-[#0B0D11] border border-white/[0.08] rounded-lg w-fit shrink-0">
          <button
            type="button"
            onClick={() => handleSwitchMode('clean')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              listenMode === 'clean'
                ? 'bg-amber-500 text-slate-950'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Cleaned Speaker Voice
          </button>
          <button
            type="button"
            onClick={() => handleSwitchMode('original')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              listenMode === 'original'
                ? 'bg-slate-200 text-slate-950'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Original Noisy
          </button>
        </div>
      </div>

      {/* Prominent Cleaned Video Player (ALWAYS shown first when input is a video) */}
      {result.mediaType === 'video' ? (
        <div className="space-y-2.5">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 font-semibold text-white">
              <Video className="w-4 h-4 text-amber-400 shrink-0" />
              <span>
                {listenMode === 'clean'
                  ? 'Cleaned Video Preview (Noise Removed)'
                  : 'Original Video Preview (Before Noise Removal)'}
              </span>
            </div>
            <span className="font-mono text-slate-400 tabular-nums">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          <div className="rounded-xl overflow-hidden bg-black border border-amber-500/25">
            <video
              key={isSyncedVideo ? 'synced-video' : activeMediaSrc}
              ref={(el) => {
                mediaRef.current = el;
              }}
              src={activeMediaSrc}
              controls
              playsInline
              preload="auto"
              muted={isSyncedVideo && listenMode === 'clean'}
              onPlay={handleMediaPlay}
              onPause={handleMediaPause}
              onEnded={handleMediaPause}
              onSeeking={handleMediaSeeked}
              onSeeked={handleMediaSeeked}
              onRateChange={(e) => {
                if (isSyncedVideo && syncedAudioRef.current) {
                  syncedAudioRef.current.playbackRate = e.currentTarget.playbackRate;
                }
              }}
              onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || result.durationSec)}
              onTimeUpdate={(e) => handleMediaTimeUpdate(e.currentTarget.currentTime)}
              className="w-full max-h-[460px] bg-black"
            />
          </div>

          {isSyncedVideo && (
            <audio
              ref={syncedAudioRef}
              src={cleanAudioTrackUrl}
              preload="auto"
              muted={listenMode !== 'clean'}
              className="hidden"
            />
          )}
        </div>
      ) : (
        <audio
          key={activeMediaSrc}
          ref={(el) => {
            mediaRef.current = el;
          }}
          src={activeMediaSrc}
          preload="auto"
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || result.durationSec)}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          className="hidden"
        />
      )}

      {/* Real Measured Acoustic Metrics Strip (Unboxed Tabular Figures) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 py-2">
        <div className="space-y-1">
          <p className="text-xs text-slate-400">Noise Floor Reduced</p>
          <p className="text-2xl font-bold text-emerald-400 font-mono tabular-nums">
            -{result.noiseReductionDb.toFixed(1)} dB
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-slate-400">Speaker Voice Preserved</p>
          <p className="text-2xl font-bold text-white font-mono tabular-nums">
            {result.speechPreservationPct.toFixed(1)}%
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-slate-400">Detected Speech</p>
          <p className="text-2xl font-bold text-white font-mono tabular-nums">
            {result.speechDurationSec.toFixed(1)}s
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-slate-400">Total Duration</p>
          <p className="text-2xl font-bold text-slate-200 font-mono tabular-nums">
            {formatTime(result.durationSec)}
          </p>
        </div>
      </div>

      {/* Dual Synchronized Waveform Visualizers */}
      <div className="space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-amber-400">
              Cleaned Output — Isolated Speaker Voice
            </span>
            <span className="font-mono text-slate-400 tabular-nums">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>
          <canvas
            ref={cleanCanvasRef}
            onClick={handleSeek}
            className="w-full h-16 rounded-lg bg-[#0B0D11] border border-white/[0.06] cursor-pointer"
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-slate-400">
              Original Input — Before Noise Removal
            </span>
            <span className="text-slate-500">Click waveform to seek</span>
          </div>
          <canvas
            ref={origCanvasRef}
            onClick={handleSeek}
            className="w-full h-12 rounded-lg bg-[#0B0D11] border border-white/[0.06] cursor-pointer"
          />
        </div>
      </div>

      {exportError && (
        <p role="alert" className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3.5 py-2.5">
          {exportError}
        </p>
      )}

      {/* Transport & Download Action Row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-4 border-t border-white/[0.08]">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={togglePlay}
            className="min-h-[44px] px-5 py-2.5 rounded-lg bg-white/10 hover:bg-white/15 text-white font-semibold text-sm inline-flex items-center gap-2 transition-colors whitespace-nowrap cursor-pointer"
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            <span>
              {isPlaying
                ? 'Pause'
                : listenMode === 'clean'
                  ? result.mediaType === 'video'
                    ? 'Play Clean Video'
                    : 'Play Clean Voice'
                  : 'Play Original'}
            </span>
          </button>
          <div className="hidden md:flex items-center gap-1.5 text-xs text-slate-400">
            <Volume2 className="w-4 h-4 shrink-0" />
            <span>Switch between Clean &amp; Original anytime while playing</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {isSyncedVideo ? (
            <>
              <button
                type="button"
                disabled={exportingVideo}
                onClick={handleDownloadSyncedVideo}
                className="min-h-[46px] px-6 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
              >
                {exportingVideo ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                    <span>Exporting Clean Video ({exportProgress}%)...</span>
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4 shrink-0" />
                    <span>Download Clean Video</span>
                  </>
                )}
              </button>
              <a
                href={cleanAudioTrackUrl}
                download={result.outputFileName.replace(/\.[^.]+$/, '.wav')}
                className="min-h-[46px] px-4 py-2.5 rounded-lg border border-white/15 bg-white/[0.04] hover:bg-white/[0.08] text-slate-200 font-semibold text-xs inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5 shrink-0" />
                <span>Clean Audio (WAV)</span>
              </a>
            </>
          ) : (
            <a
              href={result.downloadUrl}
              download={result.outputFileName}
              className="min-h-[46px] px-6 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-4 h-4 shrink-0" />
              <span>
                Download Clean {result.mediaType === 'video' ? 'Video (MP4)' : 'Audio'}
              </span>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
