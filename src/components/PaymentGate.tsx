import React, { useEffect, useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import { doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import QRCode from 'qrcode';
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  ExternalLink,
  Info,
  Lock,
  ShieldAlert,
  Smartphone,
} from 'lucide-react';
import {
  db,
  handleFirestoreError,
  MERCHANT_UPI_ID,
  MONTHLY_PRICE_INR,
  OperationType,
  PLAN_ID,
} from '../firebase';
import type { PaymentApp, SubscriptionDoc } from '../types';

interface PaymentGateProps {
  user: User;
  subscription: SubscriptionDoc | null;
  hasSelectedFile: boolean;
}

const UPI_PARAMS = `pa=${encodeURIComponent(MERCHANT_UPI_ID)}&pn=${encodeURIComponent(
  'Noise Remover AI',
)}&am=${MONTHLY_PRICE_INR}&cu=INR&tn=${encodeURIComponent('Noise Remover AI Monthly Plan')}`;

const GENERIC_UPI_LINK = `upi://pay?${UPI_PARAMS}`;

function buildAppUpiUrl(app: PaymentApp): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isAndroid = /android/i.test(ua);
  const isIOS = /iphone|ipad|ipod/i.test(ua);

  if (app === 'phonepe') {
    if (isAndroid) {
      // Official NPCI Android Intent targeting PhonePe directly
      return `intent://pay?${UPI_PARAMS}#Intent;scheme=upi;package=com.phonepe.app;end`;
    }
    if (isIOS) {
      return `phonepe://pay?${UPI_PARAMS}`;
    }
    return `upi://pay?${UPI_PARAMS}`;
  }

  if (app === 'paytm') {
    if (isAndroid) {
      // Official NPCI Android Intent targeting Paytm directly
      return `intent://pay?${UPI_PARAMS}#Intent;scheme=upi;package=net.one97.paytm;end`;
    }
    if (isIOS) {
      return `paytmmp://pay?${UPI_PARAMS}`;
    }
    return `upi://pay?${UPI_PARAMS}`;
  }

  return GENERIC_UPI_LINK;
}

export function PaymentGate({ user, subscription, hasSelectedFile }: PaymentGateProps) {
  const [selectedApp, setSelectedApp] = useState<PaymentApp>('phonepe');
  const [utrInput, setUtrInput] = useState('');
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [savingQr, setSavingQr] = useState(false);
  const [launchHint, setLaunchHint] = useState<string | null>(null);

  const revokeCount = subscription?.revokeCount ?? 0;
  const isPermanentlyBanned = revokeCount >= 2;
  const isRevoked = subscription?.status === 'revoked';
  const isExpired =
    subscription?.status === 'active' && subscription.expiresAtMs <= Date.now();

  const isMobileDevice = useMemo(() => {
    if (typeof navigator === 'undefined') return false;
    return /android|iphone|ipad|ipod/i.test(navigator.userAgent);
  }, []);

  const phonePeUrl = useMemo(() => buildAppUpiUrl('phonepe'), []);
  const paytmUrl = useMemo(() => buildAppUpiUrl('paytm'), []);

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(GENERIC_UPI_LINK, {
      width: 360,
      margin: 2,
      color: {
        dark: '#0B0D11',
        light: '#FFFFFF',
      },
      errorCorrectionLevel: 'H',
    })
      .then((url) => {
        if (active) setQrDataUrl(url);
      })
      .catch((err) => {
        console.error('QR generation failed:', err);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleUpiLinkClick = (app: PaymentApp) => {
    setSelectedApp(app);
    setLaunchHint(null);

    const appLabel = app === 'phonepe' ? 'PhonePe' : app === 'paytm' ? 'Paytm' : 'your UPI app';

    // If still visible after 1.3s (e.g. Desktop browser, embedded preview sandbox, or app not installed), show helpful fallback
    window.setTimeout(() => {
      if (document.visibilityState === 'visible') {
        if (!isMobileDevice) {
          setLaunchHint(
            `Direct ${appLabel} app launch works on mobile phones. On desktop, scan the QR code on the right or copy UPI ID ${MERCHANT_UPI_ID}.`,
          );
        } else {
          setLaunchHint(
            `If ${appLabel} didn't open inside this preview frame, open the shared site URL directly in Chrome/Safari, or tap "Save QR Code" / "Copy UPI ID" to pay ₹49 in ${appLabel}.`,
          );
        }
      }
    }, 1300);
  };

  const handleCopyUpi = async () => {
    try {
      await navigator.clipboard.writeText(MERCHANT_UPI_ID);
      setCopied(true);
    } catch {
      const el = document.createElement('textarea');
      el.value = MERCHANT_UPI_ID;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopied(true);
    }
    window.setTimeout(() => setCopied(false), 2400);
  };

  const handleSaveQrCode = async () => {
    if (!qrDataUrl) return;
    setSavingQr(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 760;
      canvas.height = 960;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = '#0B0D11';
      ctx.font = 'bold 34px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Noise Remover AI', canvas.width / 2, 86);

      ctx.fillStyle = '#475569';
      ctx.font = '600 24px sans-serif';
      ctx.fillText('Pay ₹49 Monthly Plan · PhonePe / Paytm / UPI', canvas.width / 2, 134);

      const qrImage = new Image();
      await new Promise<void>((resolve, reject) => {
        qrImage.onload = () => resolve();
        qrImage.onerror = () => reject(new Error('Failed to load QR image'));
        qrImage.src = qrDataUrl;
      });

      const qrSize = 520;
      const qrX = (canvas.width - qrSize) / 2;
      const qrY = 175;
      ctx.drawImage(qrImage, qrX, qrY, qrSize, qrSize);

      ctx.fillStyle = '#0B0D11';
      ctx.font = 'bold 28px monospace';
      ctx.fillText(`UPI ID: ${MERCHANT_UPI_ID}`, canvas.width / 2, 765);

      ctx.fillStyle = '#64748B';
      ctx.font = '500 21px sans-serif';
      ctx.fillText(
        'Scan & pay ₹49, then enter your 12-digit UTR on the website.',
        canvas.width / 2,
        822,
      );

      const pngUrl = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = pngUrl;
      link.download = 'noise-remover-ai-upi-qr-49.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      setSavingQr(false);
    }
  };

  const handleSubmitUtr = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (isPermanentlyBanned) {
      setErrorMsg(
        'Your account has been permanently blocked after 2 revocations. You can no longer submit UTR numbers.',
      );
      return;
    }

    const cleanUtr = utrInput.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().trim();
    if (cleanUtr.length < 8 || cleanUtr.length > 32) {
      setErrorMsg(
        'Please enter a valid 12-digit UPI UTR / Transaction Reference number (8–32 characters).',
      );
      return;
    }

    if (subscription?.utr && cleanUtr === subscription.utr) {
      setErrorMsg(
        'This UTR was already used on your account. Please enter a new valid payment UTR.',
      );
      return;
    }

    setSubmitting(true);
    const paymentId = `pay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const expiresAtMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const safeName = (user.displayName || user.email?.split('@')[0] || 'User').slice(0, 120);
    const safeEmail = (user.email || '').slice(0, 160);

    try {
      const batch = writeBatch(db);

      const utrClaimRef = doc(db, 'utrClaims', cleanUtr);
      batch.set(utrClaimRef, {
        utr: cleanUtr,
        userId: user.uid,
        createdAt: serverTimestamp(),
      });

      const subRef = doc(db, 'subscriptions', user.uid);
      if (subscription) {
        batch.update(subRef, {
          utr: cleanUtr,
          paymentApp: selectedApp,
          status: 'active',
          revokedReason: '',
          expiresAtMs,
          userName: safeName,
          userEmail: safeEmail,
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.set(subRef, {
          userId: user.uid,
          userEmail: safeEmail,
          userName: safeName,
          utr: cleanUtr,
          paymentApp: selectedApp,
          upiId: MERCHANT_UPI_ID,
          amount: MONTHLY_PRICE_INR,
          plan: PLAN_ID,
          status: 'active',
          revokedReason: '',
          revokeCount: 0,
          expiresAtMs,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      const paymentRef = doc(db, 'payments', paymentId);
      batch.set(paymentRef, {
        paymentId,
        userId: user.uid,
        userEmail: safeEmail,
        userName: safeName,
        utr: cleanUtr,
        paymentApp: selectedApp,
        upiId: MERCHANT_UPI_ID,
        amount: MONTHLY_PRICE_INR,
        status: 'approved',
        revokedReason: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      await batch.commit();
      setUtrInput('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('permission') || msg.toLowerCase().includes('already exists')) {
        setErrorMsg(
          'This UTR number has already been claimed or could not be verified. Please check your PhonePe/Paytm transaction history and enter a valid unused UTR.',
        );
      } else {
        handleFirestoreError(err, OperationType.WRITE, `subscriptions/${user.uid}`);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      id="payment-gate"
      className="bg-[#12161E] border border-white/[0.08] rounded-xl p-6 sm:p-8 space-y-6"
    >
      {/* Header Row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-white/[0.08]">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-amber-400 text-sm font-medium">
            <Lock className="w-4 h-4 shrink-0" />
            <span>
              {hasSelectedFile
                ? 'File Ready — Complete Payment to Process & Download'
                : 'Activate Monthly Plan to Process & Download'}
            </span>
          </div>
          <h2 className="text-2xl font-bold text-white tracking-tight">Pay ₹49 Monthly</h2>
          <p className="text-sm text-slate-400">
            Pay via PhonePe or Paytm and enter your UTR number below for instant auto-approval.
            Noise removal and download unlock immediately after UTR submission.
          </p>
        </div>
        <div className="text-left sm:text-right shrink-0">
          <div className="text-3xl font-bold text-white font-mono tabular-nums">₹49</div>
          <div className="text-xs text-slate-400">30 days · Unlimited files</div>
        </div>
      </div>

      {/* Revoked / Expired Warning */}
      {isRevoked && (
        <div
          role="alert"
          className="rounded-lg bg-red-500/10 border border-red-500/30 p-4 flex items-start gap-3"
        >
          <ShieldAlert className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <div className="space-y-1.5 text-sm">
            <p className="font-semibold text-red-300">
              Access Revoked by Admin ({revokeCount}/2)
            </p>
            <p className="text-red-200/80 text-xs leading-relaxed">
              {subscription.revokedReason
                ? `Reason: ${subscription.revokedReason}. `
                : 'Your previous UTR could not be verified. '}
              Please pay ₹49 to <span className="font-mono text-white">{MERCHANT_UPI_ID}</span> and
              enter a valid new UTR number below to restore access.
            </p>
            {revokeCount === 1 && (
              <p className="text-amber-300 text-xs font-medium">
                Final Warning: If your plan is revoked 1 more time (2/2), your account will be
                permanently blocked from submitting UTRs and using Noise Remover AI.
              </p>
            )}
          </div>
        </div>
      )}

      {isExpired && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-200 leading-relaxed">
            Your previous 30-day plan has expired. Pay ₹49 via PhonePe or Paytm and enter your new
            UTR to renew instantly.
          </p>
        </div>
      )}

      {/* Two-Column Payment Instructions: Direct App Links + QR Code */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <div className="lg:col-span-7 space-y-6">
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
              <Smartphone className="w-4 h-4 text-amber-400 shrink-0" />
              <span>01. Tap to Pay ₹49 Directly in App</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <a
                href={phonePeUrl}
                onClick={() => handleUpiLinkClick('phonepe')}
                className="min-h-[50px] px-4 py-3 rounded-lg bg-[#5F259F] hover:bg-[#6E2EB5] text-white font-semibold text-sm flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
              >
                <span>Pay ₹49 via PhonePe</span>
                <ExternalLink className="w-4 h-4 shrink-0" />
              </a>

              <a
                href={paytmUrl}
                onClick={() => handleUpiLinkClick('paytm')}
                className="min-h-[50px] px-4 py-3 rounded-lg bg-[#00BAF2] hover:bg-[#19C4F8] text-slate-950 font-semibold text-sm flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
              >
                <span>Pay ₹49 via Paytm</span>
                <ExternalLink className="w-4 h-4 shrink-0" />
              </a>
            </div>

            <a
              href={GENERIC_UPI_LINK}
              onClick={() => handleUpiLinkClick('upi')}
              className="w-full min-h-[42px] px-4 py-2 rounded-lg border border-white/15 bg-white/[0.03] hover:bg-white/[0.06] text-slate-200 font-medium text-xs flex items-center justify-center gap-2 transition-colors"
            >
              <span>Or Open Any UPI App (GPay / BHIM / PhonePe / Paytm)</span>
              <ExternalLink className="w-3.5 h-3.5 shrink-0" />
            </a>

            {launchHint && (
              <div className="rounded-lg bg-amber-500/10 border border-amber-500/25 px-3.5 py-2.5 flex items-start gap-2.5 text-xs text-amber-200 leading-relaxed">
                <Info className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <span>{launchHint}</span>
              </div>
            )}
          </div>

          {/* Copy UPI ID Row */}
          <div className="space-y-2 pt-2 border-t border-white/[0.08]">
            <p className="text-xs font-medium text-slate-400">
              Official PhonePe / UPI ID (Click to Copy)
            </p>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3 rounded-lg bg-[#0B0D11] border border-white/10">
              <span className="font-mono text-base font-semibold text-white tracking-wide select-all">
                {MERCHANT_UPI_ID}
              </span>
              <button
                type="button"
                onClick={handleCopyUpi}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-white/10 hover:bg-white/15 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-emerald-300">UPI ID Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy UPI ID</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Step 2: Mandatory UTR Verification Form */}
          <form onSubmit={handleSubmitUtr} className="space-y-4 pt-4 border-t border-white/[0.08]">
            <div className="space-y-1">
              <h3 className="text-sm font-semibold text-slate-100">
                02. Enter UTR Number to Unlock Noise Removal &amp; Download
              </h3>
              <p className="text-xs text-slate-400">
                After paying ₹49, copy the 12-digit UTR / Ref ID from your PhonePe or Paytm receipt
                and submit below for instant auto-approval.
              </p>
            </div>

            <div className="flex items-center gap-1 p-1 bg-[#0B0D11] border border-white/[0.08] rounded-lg w-fit">
              {(
                [
                  { id: 'phonepe', label: 'PhonePe' },
                  { id: 'paytm', label: 'Paytm' },
                  { id: 'upi', label: 'Other UPI' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setSelectedApp(opt.id)}
                  className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                    selectedApp === opt.id
                      ? 'bg-amber-500 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                value={utrInput}
                onChange={(e) => {
                  setUtrInput(e.target.value.toUpperCase());
                  if (errorMsg) setErrorMsg(null);
                }}
                placeholder="Enter 12-digit UTR (e.g. 432198765432)"
                maxLength={32}
                required
                aria-label="UPI UTR Reference Number"
                className="flex-1 min-h-[46px] px-4 py-2.5 rounded-lg bg-[#0B0D11] border border-white/15 focus:border-amber-400 focus:outline-none text-white placeholder:text-slate-500 font-mono text-sm tracking-wider"
              />
              <button
                type="submit"
                disabled={submitting || utrInput.trim().length < 8}
                className="min-h-[46px] px-6 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm transition-colors disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {submitting ? 'Activating...' : 'Verify UTR & Unlock'}
              </button>
            </div>

            {errorMsg && (
              <p className="text-xs text-red-400 flex items-start gap-1.5" role="alert">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </p>
            )}

            <p className="text-xs text-slate-500">
              Auto-approved immediately upon valid UTR entry. Fake or unverified UTRs are reviewed
              by the owner and revoked without notice.
            </p>
          </form>
        </div>

        {/* Right: Real Scannable UPI QR Code + Save QR Code Button */}
        <div className="lg:col-span-5 flex flex-col items-center justify-center p-6 rounded-xl bg-[#0B0D11] border border-white/[0.08] space-y-4">
          <div className="text-center space-y-0.5">
            <p className="text-sm font-semibold text-white">Scan QR with PhonePe or Paytm</p>
            <p className="text-xs text-slate-400 font-mono tabular-nums">
              ₹49 · {MERCHANT_UPI_ID}
            </p>
          </div>

          <div className="bg-white p-3 rounded-xl shadow-sm">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt={`UPI QR code to pay ₹49 to ${MERCHANT_UPI_ID}`}
                className="w-48 h-48 sm:w-52 sm:h-52 block"
              />
            ) : (
              <div className="w-48 h-48 sm:w-52 sm:h-52 flex items-center justify-center text-slate-500 text-xs">
                Generating QR...
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={handleSaveQrCode}
            disabled={!qrDataUrl || savingQr}
            className="w-full min-h-[42px] px-4 py-2 rounded-lg border border-white/15 bg-white/[0.04] hover:bg-white/[0.08] text-slate-100 font-semibold text-xs flex items-center justify-center gap-2 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <Download className="w-4 h-4 text-amber-400 shrink-0" />
            <span>{savingQr ? 'Saving QR PNG...' : 'Save QR Code'}</span>
          </button>

          <p className="text-[11px] text-slate-500 text-center leading-relaxed">
            Save this QR image to your gallery to scan directly inside PhonePe or Paytm.
          </p>
        </div>
      </div>
    </section>
  );
}
