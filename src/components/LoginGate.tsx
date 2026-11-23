import { useState } from 'react';
import { AudioWaveform, Lock, Mic, ShieldCheck, VolumeX } from 'lucide-react';

interface LoginGateProps {
  onGoogleSignIn: () => Promise<void>;
  authError: string | null;
}

export function LoginGate({ onGoogleSignIn, authError }: LoginGateProps) {
  const [signingIn, setSigningIn] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);

  const handleClick = async () => {
    setSigningIn(true);
    try {
      await onGoogleSignIn();
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0D11] text-slate-100 flex flex-col">
      {/* Top Bar Contract: Single-row 3-zone header */}
      <header className="w-full border-b border-white/[0.08]">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between gap-8">
          <span className="text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0">
            Noise Cleaner AI
          </span>
          <div className="hidden md:flex items-center gap-6 text-sm text-slate-400">
            <span className="whitespace-nowrap shrink-0">Voice Isolation</span>
            <span className="whitespace-nowrap shrink-0">Audio &amp; Video</span>
            <span className="whitespace-nowrap shrink-0 text-emerald-400 font-medium">100% Free Access</span>
          </div>
          <button
            type="button"
            onClick={handleClick}
            disabled={signingIn}
            className="px-4 py-2 rounded-lg bg-amber-500 text-slate-950 font-semibold text-sm hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0 disabled:opacity-60 cursor-pointer"
          >
            {signingIn ? 'Signing in...' : 'Sign in'}
          </button>
        </div>
      </header>

      {/* Main Split Viewport */}
      <main className="flex-1 flex items-center py-12 px-6">
        <div className="max-w-6xl mx-auto w-full grid grid-cols-1 lg:grid-cols-12 gap-10 items-stretch">
          {/* Left Column: Value Proposition & Mandatory Google Login */}
          <div className="lg:col-span-6 flex flex-col justify-center space-y-8">
            <div className="space-y-4">
              <p className="text-sm font-medium text-amber-400">
                Neural Speech Isolation Studio
              </p>
              <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-white leading-[1.12]">
                Only the speaker’s voice. Zero background noise.
              </h1>
              <p className="text-base text-slate-400 leading-relaxed max-w-xl">
                Eliminate ceiling fans, AC hum, street traffic, engines, and car horns from your
                audio or video recordings—with look-ahead speech protection so not a single word
                gets cut off.
              </p>
            </div>

            {/* Clean unboxed feature breakdown */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 pt-2 border-t border-white/[0.08]">
              <div className="space-y-1.5 pt-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                  <VolumeX className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>Fan, Traffic &amp; Horn Removal</span>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Recurrent neural network filters non-human noise across 48 kHz studio frames.
                </p>
              </div>
              <div className="space-y-1.5 pt-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                  <Mic className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>Zero Word Clipping</span>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Bidirectional speech look-ahead keeps every syllable, breath, and sentence intact.
                </p>
              </div>
            </div>

            {/* Mandatory Google Login Gate Box */}
            <div className="bg-[#12161E] border border-white/[0.08] rounded-xl p-6 space-y-4">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
                <Lock className="w-4 h-4 text-amber-400 shrink-0" />
                <span>Google sign-in is required to access the studio</span>
              </div>

              <button
                type="button"
                onClick={handleClick}
                disabled={signingIn}
                className="w-full min-h-[48px] px-5 py-3 rounded-lg bg-white text-slate-950 font-semibold text-sm hover:bg-slate-100 transition-colors flex items-center justify-center gap-3 disabled:opacity-60 cursor-pointer"
              >
                <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="#4285F4"
                    d="M23.745 12.27c0-.79-.07-1.54-.19-2.27h-11.3v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
                  />
                  <path
                    fill="#34A853"
                    d="M12.255 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96h-3.98v3.09C3.515 21.3 7.565 24 12.255 24z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.525 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62h-3.98a11.86 11.86 0 000 10.76l3.98-3.09z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12.255 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C18.205 1.19 15.495 0 12.255 0c-4.69 0-8.74 2.7-10.71 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"
                  />
                </svg>
                <span>{signingIn ? 'Connecting to Google...' : 'Continue with Google'}</span>
              </button>

              {authError && (
                <p className="text-xs text-red-400 leading-relaxed" role="alert">
                  {authError}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                <span>Supports MP3, WAV, M4A, MP4, MOV, MKV</span>
                <span aria-hidden="true">·</span>
                <span className="text-emerald-400 font-medium">100% Free Forever</span>
                <span aria-hidden="true">·</span>
                <span>No payment required</span>
              </div>
            </div>
          </div>

          {/* Right Column: Bespoke Broadcast Studio Visual */}
          <div className="lg:col-span-6 relative rounded-xl overflow-hidden border border-white/[0.08] bg-[#12161E] min-h-[360px]">
            {!imgFailed ? (
              <img
                src="/src/assets/images/studio_vocal_isolation_1795093681605.jpg"
                alt="Broadcast studio condenser microphone and acoustic treatment desk"
                referrerPolicy="no-referrer"
                onError={() => setImgFailed(true)}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center p-10 bg-gradient-to-br from-[#161B26] to-[#0B0D11] text-slate-400 gap-4">
                <AudioWaveform className="w-12 h-12 text-amber-400" />
                <p className="text-sm font-medium text-slate-300">Noise Cleaner AI Studio</p>
              </div>
            )}

            <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent flex flex-col justify-end p-8">
              <div className="space-y-2 max-w-md">
                <div className="flex items-center gap-2 text-xs font-medium text-amber-300">
                  <ShieldCheck className="w-4 h-4 shrink-0" />
                  <span>Broadcast-Grade 48 kHz Voice Mastering</span>
                </div>
                <p className="text-lg font-semibold text-white leading-snug">
                  Keep original video untouched while isolating pure speaker dialogue.
                </p>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Upload your clip after signing in, remove fan, traffic, and horn noise, and
                  download studio-clean audio or video completely free.
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
