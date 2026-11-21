import React, { useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import {
  AlertCircle,
  CheckCircle2,
  FileAudio,
  FileVideo,
  Loader2,
  Sliders,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type {
  AudioExportFormat,
  DenoiseApiResponse,
  IsolationMode,
  SubscriptionDoc,
} from '../types';
import { processNoiseRemovalInBrowser } from '../utils/clientDenoiseEngine';
import { PaymentGate } from './PaymentGate';
import { WaveformCompare } from './WaveformCompare';

interface NoiseRemoverStudioProps {
  user: User;
  subscription: SubscriptionDoc | null;
  hasActiveSubscription: boolean;
  isAdmin: boolean;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ms: number): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(ms));
}

export function NoiseRemoverStudio({
  user,
  subscription,
  hasActiveSubscription,
  isAdmin,
}: NoiseRemoverStudioProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const [mode, setMode] = useState<IsolationMode>('balanced');
  const [noiseStrength, setNoiseStrength] = useState<number>(85);
  const [enhanceVoice, setEnhanceVoice] = useState<boolean>(true);
  const [enhanceStrength, setEnhanceStrength] = useState<number>(65);
  const [removeEcho, setRemoveEcho] = useState<boolean>(true);
  const [normalizeLoudness, setNormalizeLoudness] = useState<boolean>(true);
  const [voiceVolume, setVoiceVolume] = useState<number>(100);
  const [audioFormat, setAudioFormat] = useState<AudioExportFormat>('wav');
  const [processing, setProcessing] = useState(false);
  const [stageText, setStageText] = useState('');
  const [processError, setProcessError] = useState<string | null>(null);
  const [result, setResult] = useState<DenoiseApiResponse | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const applyPreset = (nextMode: IsolationMode) => {
    setMode(nextMode);
    if (nextMode === 'maximum') {
      setNoiseStrength(100);
      setEnhanceVoice(true);
      setEnhanceStrength(75);
      setRemoveEcho(true);
      setNormalizeLoudness(true);
      setVoiceVolume(100);
    } else if (nextMode === 'natural') {
      setNoiseStrength(65);
      setEnhanceVoice(false);
      setEnhanceStrength(40);
      setRemoveEcho(false);
      setNormalizeLoudness(true);
      setVoiceVolume(100);
    } else {
      setNoiseStrength(85);
      setEnhanceVoice(true);
      setEnhanceStrength(65);
      setRemoveEcho(true);
      setNormalizeLoudness(true);
      setVoiceVolume(100);
    }
  };

  // Revoke any client-created Blob URLs on unmount or result change
  useEffect(() => {
    const currentUrl = result?.streamUrl;
    return () => {
      if (currentUrl && currentUrl.startsWith('blob:')) {
        URL.revokeObjectURL(currentUrl);
      }
    };
  }, [result?.streamUrl]);

  // Clear processed download if subscription is revoked mid-session
  useEffect(() => {
    if (!hasActiveSubscription && result) {
      setResult(null);
    }
  }, [hasActiveSubscription, result]);

  useEffect(() => {
    if (!selectedFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(selectedFile);
    setPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [selectedFile]);

  const isVideoFile = Boolean(
    selectedFile &&
      (selectedFile.type.startsWith('video/') ||
        /\.(mp4|mov|mkv|webm|avi|3gp|m4v)$/i.test(selectedFile.name)),
  );

  const handleSelectFile = (file: File | null | undefined) => {
    if (!file) return;
    setProcessError(null);

    if (file.size > 150 * 1024 * 1024) {
      setProcessError('File exceeds 150 MB limit. Please upload a smaller clip.');
      return;
    }

    const isMedia =
      file.type.startsWith('audio/') ||
      file.type.startsWith('video/') ||
      /\.(mp3|wav|m4a|aac|ogg|flac|opus|mp4|mov|mkv|webm|avi|3gp)$/i.test(file.name);

    if (!isMedia) {
      setProcessError(
        'Please upload a supported audio or video file (MP3, WAV, M4A, MP4, MOV, MKV, WEBM).',
      );
      return;
    }

    setSelectedFile(file);
    setResult(null);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    handleSelectFile(file);
  };

  const handleClearFile = () => {
    setSelectedFile(null);
    setResult(null);
    setProcessError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleProcessNoiseRemoval = async () => {
    if (!selectedFile || !hasActiveSubscription) return;
    setProcessing(true);
    setProcessError(null);
    setResult(null);
    setStageText('Extracting 48 kHz audio & removing AC/wind rumble...');

    const stageTimer1 = window.setTimeout(() => {
      setStageText(
        'AI isolating speaker voice & removing fan, traffic, horns & background noise...',
      );
    }, 1200);
    const stageTimer2 = window.setTimeout(() => {
      setStageText(
        enhanceVoice
          ? 'Applying AI voice enhancement, echo cleanup & loudness normalization...'
          : 'Polishing studio silence floor & finalizing clean output...',
      );
    }, 3200);

    try {
      let payload: DenoiseApiResponse | null = null;
      let shouldUseBrowserEngine = false;

      try {
        const idToken = await user.getIdToken(true);
        const formData = new FormData();
        formData.append('file', selectedFile);
        formData.append('mode', mode);
        formData.append('audioFormat', audioFormat);
        formData.append('noiseStrength', String(noiseStrength));
        formData.append('enhanceVoice', String(enhanceVoice));
        formData.append('enhanceStrength', String(enhanceStrength));
        formData.append('removeEcho', String(removeEcho));
        formData.append('normalizeLoudness', String(normalizeLoudness));
        formData.append('voiceVolume', String(voiceVolume));

        const response = await fetch('/api/denoise', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${idToken}`,
          },
          body: formData,
        });

        const contentType = response.headers.get('content-type') || '';
        const rawText = await response.text();

        // If a static host or SPA fallback served HTML / 404 / 405 / 502 / 503 / 504, run directly in browser
        if (
          !contentType.includes('application/json') ||
          [404, 405, 502, 503, 504].includes(response.status)
        ) {
          shouldUseBrowserEngine = true;
        } else {
          const parsed = JSON.parse(rawText) as DenoiseApiResponse & { error?: string };
          if (!response.ok) {
            // Strictly honor backend auth/paywall (403) and validation (400) errors
            throw new Error(parsed?.error || 'Noise removal failed. Please try again.');
          }
          payload = parsed;
        }
      } catch (networkOrApiErr) {
        // Re-throw explicit API/paywall errors; only fall back on network/static-host failures
        if (
          networkOrApiErr instanceof Error &&
          !networkOrApiErr.message.includes('Failed to fetch') &&
          !networkOrApiErr.message.includes('NetworkError') &&
          !networkOrApiErr.message.includes('JSON')
        ) {
          throw networkOrApiErr;
        }
        shouldUseBrowserEngine = true;
      }

      if (shouldUseBrowserEngine || !payload) {
        window.clearTimeout(stageTimer1);
        window.clearTimeout(stageTimer2);
        payload = await processNoiseRemovalInBrowser(
          selectedFile,
          mode,
          (msg) => {
            setStageText(msg);
          },
          {
            noiseStrength,
            enhanceVoice,
            enhanceStrength,
            removeEcho,
            normalizeLoudness,
            voiceVolume,
          },
        );
      }

      setResult(payload);

      // Persist job metadata cleanly to Firestore history (never blocks download)
      try {
        const jobDocRef = doc(db, 'processingJobs', payload.jobId);
        await setDoc(jobDocRef, {
          jobId: payload.jobId,
          userId: user.uid,
          fileName: (selectedFile.name || 'recording').slice(0, 200),
          mediaType: payload.mediaType,
          mode,
          durationSec: Math.max(0, Math.min(14400, Number(payload.durationSec) || 0)),
          noiseReductionDb: Math.max(0, Math.min(100, Number(payload.noiseReductionDb) || 0)),
          speechPreservationPct: Math.max(
            0,
            Math.min(100, Number(payload.speechPreservationPct) || 0),
          ),
          createdAt: serverTimestamp(),
        });
      } catch (fsErr) {
        try {
          handleFirestoreError(fsErr, OperationType.CREATE, `processingJobs/${payload.jobId}`);
        } catch (loggedErr) {
          console.error('History save error:', loggedErr);
        }
      }
    } catch (err) {
      setProcessError(
        err instanceof Error ? err.message : 'Unable to process media file. Please try again.',
      );
    } finally {
      window.clearTimeout(stageTimer1);
      window.clearTimeout(stageTimer2);
      setProcessing(false);
      setStageText('');
    }
  };

  return (
    <div className="space-y-8">
      {/* Studio Heading + Unboxed Subscription Status Line */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="space-y-1.5">
          <h1 className="text-3xl font-bold text-white tracking-tight">Voice Isolation Studio</h1>
          <p className="text-sm text-slate-400 max-w-2xl">
            Upload your noisy audio or video clip. Our neural engine eliminates ceiling fans,
            vehicles, traffic, and horns while keeping the speaker’s voice crystal clear and intact.
          </p>
        </div>

        {isAdmin ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300 shrink-0">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="font-semibold text-emerald-300">Owner Access</span>
            <span aria-hidden="true" className="text-slate-600">·</span>
            <span>Free Unlimited Processing</span>
          </div>
        ) : (
          hasActiveSubscription &&
          subscription && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300 shrink-0">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span className="font-semibold text-emerald-300">Monthly Plan Active</span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span className="tabular-nums">
                Valid until {formatDate(subscription.expiresAtMs)}
              </span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span className="font-mono text-slate-400">UTR {subscription.utr}</span>
            </div>
          )
        )}
      </div>

      {/* Step 1: Upload Audio or Video File */}
      <section className="bg-[#12161E] border border-white/[0.08] rounded-xl p-6 sm:p-8 space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <h2 className="text-base font-semibold text-white">
              01. Upload Audio or Video File
            </h2>
            <p className="text-xs text-slate-400">
              Supports MP3, WAV, M4A, OGG, AAC, MP4, MOV, MKV, WEBM up to 150 MB
            </p>
          </div>
          {selectedFile && (
            <button
              type="button"
              onClick={handleClearFile}
              disabled={processing}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-red-300 hover:bg-red-500/10 transition-colors cursor-pointer disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Remove File</span>
            </button>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,video/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.mp4,.mov,.mkv,.webm"
          onChange={(e) => handleSelectFile(e.target.files?.[0])}
          className="hidden"
        />

        {!selectedFile ? (
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`rounded-xl border border-dashed p-10 sm:p-14 text-center transition-colors cursor-pointer ${
              isDragging
                ? 'border-amber-400 bg-amber-500/10'
                : 'border-white/15 bg-[#0B0D11] hover:border-amber-400/60 hover:bg-white/[0.02]'
            }`}
          >
            <div className="mx-auto w-12 h-12 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mb-4">
              <Upload className="w-5 h-5 text-amber-400" />
            </div>
            <p className="text-base font-semibold text-white mb-1">
              Drop your audio or video file here, or click to browse
            </p>
            <p className="text-xs text-slate-400">
              Original video quality is preserved untouched while background noise is removed
            </p>
          </div>
        ) : (
          <div className="rounded-xl bg-[#0B0D11] border border-white/[0.08] p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0">
                  {isVideoFile ? (
                    <FileVideo className="w-5 h-5 text-amber-400" />
                  ) : (
                    <FileAudio className="w-5 h-5 text-amber-400" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{selectedFile.name}</p>
                  <div className="flex items-center gap-2 text-xs text-slate-400 tabular-nums">
                    <span>{isVideoFile ? 'Video File' : 'Audio File'}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatFileSize(selectedFile.size)}</span>
                    <span aria-hidden="true">·</span>
                    <span>Original Preview</span>
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={processing}
                className="px-3.5 py-2 rounded-lg border border-white/15 bg-white/[0.03] hover:bg-white/[0.07] text-xs font-medium text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
              >
                Choose Different File
              </button>
            </div>

            {previewUrl && (
              isVideoFile ? (
                <video
                  src={previewUrl}
                  controls
                  playsInline
                  preload="metadata"
                  className="w-full max-h-[300px] rounded-lg bg-black border border-white/[0.06]"
                />
              ) : (
                <audio src={previewUrl} controls className="w-full" />
              )
            )}
          </div>
        )}

        {processError && (
          <div
            role="alert"
            className="rounded-lg bg-red-500/10 border border-red-500/30 p-3.5 flex items-start gap-2.5 text-xs text-red-300"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
            <span>{processError}</span>
          </div>
        )}
      </section>

      {/* Step 2: STRICT PAYWALL — Payment Gate if Unpaid/Revoked, Processing Controls ONLY if Paid */}
      {!hasActiveSubscription ? (
        <PaymentGate
          user={user}
          subscription={subscription}
          hasSelectedFile={Boolean(selectedFile)}
        />
      ) : (
        <>
          <section className="bg-[#12161E] border border-white/[0.08] rounded-xl p-6 sm:p-8 space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-white/[0.08]">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Sliders className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>02. AI Audio Cleaner &amp; Voice Studio</span>
                </div>
                <p className="text-xs text-slate-400">
                  Remove ceiling fans, AC hum, traffic, horns &amp; room echo while keeping every
                  spoken word crisp, warm, and studio-leveled.
                </p>
              </div>
            </div>

            {/* Quick Studio Presets */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {(
                [
                  {
                    id: 'balanced',
                    title: 'Studio Clean',
                    subtitle: 'Recommended · Reduce Noise + Enhance Voice',
                    desc: 'Dead-quiet background pauses, clean fan & traffic removal, echo reduction, and crisp studio clarity.',
                  },
                  {
                    id: 'maximum',
                    title: 'Heavy Street & Fan',
                    subtitle: '100% Suppression · Loud Outdoor Noise',
                    desc: 'Strongest AI suppression for busy roads, loud vehicle horns, crowded markets, and heavy fans.',
                  },
                  {
                    id: 'natural',
                    title: 'Natural Podcast',
                    subtitle: '65% Reduction · Pure Uncolored Voice',
                    desc: 'Gentle background cleanup with Enhance Voice off to preserve natural indoor tone.',
                  },
                ] as const
              ).map((profile) => {
                const active = mode === profile.id;
                return (
                  <button
                    key={profile.id}
                    type="button"
                    disabled={processing}
                    onClick={() => applyPreset(profile.id)}
                    className={`text-left p-4 rounded-xl border transition-colors cursor-pointer disabled:opacity-50 ${
                      active
                        ? 'bg-amber-500/10 border-amber-400/70'
                        : 'bg-[#0B0D11] border-white/[0.08] hover:border-white/20'
                    }`}
                  >
                    <div className="space-y-1">
                      <p className={`text-sm font-semibold ${active ? 'text-amber-300' : 'text-white'}`}>
                        {profile.title}
                      </p>
                      <p className="text-xs text-slate-400">{profile.subtitle}</p>
                      <p className="text-xs text-slate-500 leading-relaxed pt-1.5">
                        {profile.desc}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Primary AI Controls: Reduce Noise + Enhance Voice */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Reduce Noise Strength */}
              <div className="rounded-xl bg-[#0B0D11] border border-white/[0.08] p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-white">Reduce Noise</p>
                    <p className="text-xs text-slate-400">
                      AI background fan, hum, traffic &amp; horn removal
                    </p>
                  </div>
                  <span className="text-sm font-bold text-amber-400 font-mono tabular-nums">
                    {noiseStrength}%
                  </span>
                </div>
                <input
                  type="range"
                  min={20}
                  max={100}
                  step={5}
                  disabled={processing}
                  value={noiseStrength}
                  onChange={(e) => setNoiseStrength(Number(e.target.value))}
                  aria-label="Reduce Noise Strength"
                  className="w-full accent-amber-400 cursor-pointer disabled:opacity-50"
                />
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span>Light (20%)</span>
                  <span>Studio Default (85%)</span>
                  <span>Max (100%)</span>
                </div>
              </div>

              {/* Enhance Voice Toggle & Intensity */}
              <div className="rounded-xl bg-[#0B0D11] border border-white/[0.08] p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-white">Enhance Voice</p>
                    <p className="text-xs text-slate-400">
                      Studio mic warmth, vocal clarity &amp; smooth de-esser
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enhanceVoice}
                    disabled={processing}
                    onClick={() => setEnhanceVoice((v) => !v)}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 ${
                      enhanceVoice ? 'bg-amber-500' : 'bg-slate-700'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-slate-950 transition-transform ${
                        enhanceVoice ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                <div className={enhanceVoice ? 'space-y-1.5' : 'space-y-1.5 opacity-40'}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400">Voice Clarity Intensity</span>
                    <span className="font-mono font-semibold text-white tabular-nums">
                      {enhanceVoice ? `${enhanceStrength}%` : 'Off'}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={15}
                    max={100}
                    step={5}
                    disabled={processing || !enhanceVoice}
                    value={enhanceStrength}
                    onChange={(e) => setEnhanceStrength(Number(e.target.value))}
                    aria-label="Enhance Voice Intensity"
                    className="w-full accent-amber-400 cursor-pointer disabled:opacity-50"
                  />
                </div>
              </div>
            </div>

            {/* Secondary Studio Functions: Remove Echo, Normalize Loudness & Voice Volume */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Remove Echo & Reverb */}
              <div className="rounded-xl bg-[#0B0D11] border border-white/[0.08] p-4 flex items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <p className="text-sm font-semibold text-white">Remove Echo</p>
                  <p className="text-xs text-slate-400">Tightens hollow room reverb</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={removeEcho}
                  disabled={processing}
                  onClick={() => setRemoveEcho((v) => !v)}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 ${
                    removeEcho ? 'bg-amber-500' : 'bg-slate-700'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-slate-950 transition-transform ${
                      removeEcho ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              {/* Normalize Loudness */}
              <div className="rounded-xl bg-[#0B0D11] border border-white/[0.08] p-4 flex items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <p className="text-sm font-semibold text-white">Normalize Loudness</p>
                  <p className="text-xs text-slate-400">Steady -14 LUFS social volume</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={normalizeLoudness}
                  disabled={processing}
                  onClick={() => setNormalizeLoudness((v) => !v)}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 ${
                    normalizeLoudness ? 'bg-amber-500' : 'bg-slate-700'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-slate-950 transition-transform ${
                      normalizeLoudness ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              {/* Voice Volume Trim / Boost */}
              <div className="rounded-xl bg-[#0B0D11] border border-white/[0.08] p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-white">Voice Volume</p>
                  <span className="text-xs font-bold text-amber-400 font-mono tabular-nums">
                    {voiceVolume}%
                  </span>
                </div>
                <input
                  type="range"
                  min={50}
                  max={200}
                  step={10}
                  disabled={processing}
                  value={voiceVolume}
                  onChange={(e) => setVoiceVolume(Number(e.target.value))}
                  aria-label="Voice Volume"
                  className="w-full accent-amber-400 cursor-pointer disabled:opacity-50"
                />
              </div>
            </div>

            {/* Export Format + Process CTA */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-4 border-t border-white/[0.08]">
              {!isVideoFile ? (
                <div className="flex items-center gap-3">
                  <span className="text-xs font-medium text-slate-400">Output Format:</span>
                  <div className="flex items-center gap-1 p-1 bg-[#0B0D11] border border-white/[0.08] rounded-lg">
                    <button
                      type="button"
                      disabled={processing}
                      onClick={() => setAudioFormat('wav')}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                        audioFormat === 'wav'
                          ? 'bg-white text-slate-950 font-semibold'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      WAV (Lossless)
                    </button>
                    <button
                      type="button"
                      disabled={processing}
                      onClick={() => setAudioFormat('mp3')}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                        audioFormat === 'mp3'
                          ? 'bg-white text-slate-950 font-semibold'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      MP3 (320 kbps)
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-400">
                  Video output: Original video preserved + 192 kbps studio-clean AAC voice
                </p>
              )}

              <button
                type="button"
                disabled={!selectedFile || processing}
                onClick={handleProcessNoiseRemoval}
                className="min-h-[48px] px-7 py-3 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm inline-flex items-center justify-center gap-2 transition-colors disabled:opacity-45 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {processing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                    <span>Cleaning Audio...</span>
                  </>
                ) : (
                  <>
                    <Wand2 className="w-4 h-4 shrink-0" />
                    <span>Remove Background Noise</span>
                  </>
                )}
              </button>
            </div>

            {processing && stageText && (
              <div className="rounded-lg bg-[#0B0D11] border border-amber-500/25 px-4 py-3 flex items-center gap-3 text-xs text-amber-200">
                <Loader2 className="w-4 h-4 animate-spin text-amber-400 shrink-0" />
                <span>{stageText}</span>
              </div>
            )}
          </section>

          {/* Step 3: Output Player, Waveform Comparison & Download (ONLY after payment + processing) */}
          {result && previewUrl && (
            <WaveformCompare originalUrl={previewUrl} result={result} />
          )}
        </>
      )}
    </div>
  );
}
