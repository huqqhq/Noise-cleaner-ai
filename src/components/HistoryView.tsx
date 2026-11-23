import { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { AudioWaveform, Receipt } from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type { PaymentRecordDoc, ProcessingJobDoc } from '../types';

interface HistoryViewProps {
  user: User;
  onBackToStudio: () => void;
}

function formatTimestamp(ts: { toDate?: () => Date } | null): string {
  if (!ts?.toDate) return 'Just now';
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ts.toDate());
}

export function HistoryView({ user, onBackToStudio }: HistoryViewProps) {
  const [jobs, setJobs] = useState<ProcessingJobDoc[]>([]);
  const [payments, setPayments] = useState<PaymentRecordDoc[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let jobsReady = false;
    let payReady = false;

    const jobsQuery = query(
      collection(db, 'processingJobs'),
      where('userId', '==', user.uid),
    );
    const unsubJobs = onSnapshot(
      jobsQuery,
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as ProcessingJobDoc)
          .sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0));
        setJobs(list);
        jobsReady = true;
        if (jobsReady && payReady) setLoading(false);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'processingJobs'),
    );

    const payQuery = query(
      collection(db, 'payments'),
      where('userId', '==', user.uid),
    );
    const unsubPay = onSnapshot(
      payQuery,
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as PaymentRecordDoc)
          .sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0));
        setPayments(list);
        payReady = true;
        if (jobsReady && payReady) setLoading(false);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'payments'),
    );

    return () => {
      unsubJobs();
      unsubPay();
    };
  }, [user.uid]);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold text-white tracking-tight">Activity History</h1>
          <p className="text-sm text-slate-400">
            Your cleaned audio and video recordings.
          </p>
        </div>
        <button
          type="button"
          onClick={onBackToStudio}
          className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs transition-colors whitespace-nowrap cursor-pointer"
        >
          Clean New File
        </button>
      </div>

      {/* Processed Recordings Table */}
      <section className="bg-[#12161E] border border-white/[0.08] rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-white/[0.08] flex items-center gap-2">
          <AudioWaveform className="w-4 h-4 text-amber-400" />
          <h2 className="text-sm font-semibold text-white">Processed Files</h2>
        </div>

        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map((n) => (
              <div key={n} className="h-10 rounded bg-white/[0.04] animate-pulse" />
            ))}
          </div>
        ) : jobs.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <p className="text-sm text-slate-400">No cleaned files logged yet.</p>
            <button
              type="button"
              onClick={onBackToStudio}
              className="px-4 py-2 rounded-lg border border-white/15 text-xs font-medium text-white hover:bg-white/[0.05] transition-colors cursor-pointer"
            >
              Open Studio
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-white/[0.08] text-xs text-slate-400">
                  <th className="py-3 px-6 font-medium">File Name</th>
                  <th className="py-3 px-4 font-medium">Type</th>
                  <th className="py-3 px-4 font-medium">Mode</th>
                  <th className="py-3 px-4 font-medium text-right">Noise Cut</th>
                  <th className="py-3 px-4 font-medium text-right">Voice Kept</th>
                  <th className="py-3 px-6 font-medium text-right">Processed At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {jobs.map((job) => (
                  <tr key={job.jobId} className="hover:bg-white/[0.02]">
                    <td className="py-3 px-6 font-medium text-slate-100 max-w-xs truncate">
                      {job.fileName}
                    </td>
                    <td className="py-3 px-4 text-slate-400 capitalize">{job.mediaType}</td>
                    <td className="py-3 px-4 text-slate-300 capitalize">{job.mode}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-emerald-400">
                      -{job.noiseReductionDb.toFixed(1)} dB
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-200">
                      {job.speechPreservationPct.toFixed(1)}%
                    </td>
                    <td className="py-3 px-6 text-right text-xs text-slate-400 tabular-nums whitespace-nowrap">
                      {formatTimestamp(job.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* UPI UTR Receipts Table (shown only if user has past submissions) */}
      {payments.length > 0 && (
        <section className="bg-[#12161E] border border-white/[0.08] rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.08] flex items-center gap-2">
            <Receipt className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-white">Past UPI UTR Submissions</h2>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-white/[0.08] text-xs text-slate-400">
                  <th className="py-3 px-6 font-medium">UTR Reference</th>
                  <th className="py-3 px-4 font-medium">UPI App</th>
                  <th className="py-3 px-4 font-medium text-right">Amount</th>
                  <th className="py-3 px-4 font-medium">Status</th>
                  <th className="py-3 px-6 font-medium text-right">Submitted At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {payments.map((pay) => (
                  <tr key={pay.paymentId} className="hover:bg-white/[0.02]">
                    <td className="py-3 px-6 font-mono text-white">{pay.utr}</td>
                    <td className="py-3 px-4 text-slate-300 capitalize">{pay.paymentApp}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-200">
                      ₹{pay.amount}
                    </td>
                    <td className="py-3 px-4">
                      {pay.status === 'approved' ? (
                        <span className="text-emerald-400 font-medium text-xs">Approved</span>
                      ) : (
                        <span className="text-red-400 font-medium text-xs">
                          Revoked{pay.revokedReason ? ` · ${pay.revokedReason}` : ''}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-6 text-right text-xs text-slate-400 tabular-nums whitespace-nowrap">
                      {formatTimestamp(pay.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
