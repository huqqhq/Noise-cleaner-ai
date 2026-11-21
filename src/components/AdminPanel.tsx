import { useEffect, useMemo, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { Ban, CheckCircle2, RotateCcw, Search, ShieldCheck } from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type { PaymentRecordDoc, SubscriptionDoc } from '../types';

function formatDate(ms: number): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(ms));
}

export function AdminPanel() {
  const [subscriptions, setSubscriptions] = useState<SubscriptionDoc[]>([]);
  const [payments, setPayments] = useState<PaymentRecordDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'revoked' | 'banned'>('all');

  const [revokingUid, setRevokingUid] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState('Fake UTR / Payment not received');
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    let subLoaded = false;
    let payLoaded = false;

    const unsubSubs = onSnapshot(
      collection(db, 'subscriptions'),
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as SubscriptionDoc)
          .sort((a, b) => (b.updatedAt?.toMillis() ?? 0) - (a.updatedAt?.toMillis() ?? 0));
        setSubscriptions(list);
        subLoaded = true;
        if (subLoaded && payLoaded) setLoading(false);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'subscriptions'),
    );

    const unsubPay = onSnapshot(
      collection(db, 'payments'),
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as PaymentRecordDoc)
          .sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0));
        setPayments(list);
        payLoaded = true;
        if (subLoaded && payLoaded) setLoading(false);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'payments'),
    );

    return () => {
      unsubSubs();
      unsubPay();
    };
  }, []);

  const stats = useMemo(() => {
    const activeCount = subscriptions.filter(
      (s) => s.status === 'active' && s.expiresAtMs > Date.now() && (s.revokeCount ?? 0) < 2,
    ).length;
    const revokedCount = subscriptions.filter((s) => s.status === 'revoked').length;
    const bannedCount = subscriptions.filter((s) => (s.revokeCount ?? 0) >= 2).length;
    return {
      total: subscriptions.length,
      activeCount,
      revokedCount,
      bannedCount,
      verifiedRevenue: activeCount * 49,
    };
  }, [subscriptions]);

  const filteredSubs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return subscriptions.filter((s) => {
      const count = s.revokeCount ?? 0;
      if (filter === 'active' && (s.status !== 'active' || count >= 2)) return false;
      if (filter === 'revoked' && s.status !== 'revoked') return false;
      if (filter === 'banned' && count < 2) return false;
      if (!q) return true;
      return (
        s.utr.toLowerCase().includes(q) ||
        s.userEmail.toLowerCase().includes(q) ||
        s.userName.toLowerCase().includes(q)
      );
    });
  }, [subscriptions, search, filter]);

  const handleConfirmRevoke = async (sub: SubscriptionDoc) => {
    setBusyUid(sub.userId);
    setFeedback(null);
    const reason = revokeReason.trim().slice(0, 200) || 'Fake UTR / Payment not received';
    const nextRevokeCount = (sub.revokeCount ?? 0) + 1;

    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'subscriptions', sub.userId), {
        status: 'revoked',
        revokedReason: reason,
        revokeCount: nextRevokeCount,
        expiresAtMs: sub.expiresAtMs,
        updatedAt: serverTimestamp(),
      });

      // Also mark matching payment log entries for this UTR as revoked
      payments
        .filter((p) => p.userId === sub.userId && p.utr === sub.utr)
        .forEach((p) => {
          batch.update(doc(db, 'payments', p.paymentId), {
            status: 'revoked',
            revokedReason: reason,
            updatedAt: serverTimestamp(),
          });
        });

      await batch.commit();
      setRevokingUid(null);
      if (nextRevokeCount >= 2) {
        setFeedback(
          `Revoked ${sub.userEmail} (${nextRevokeCount}/2) — Account is now permanently blocked from UTR submission and site access.`,
        );
      } else {
        setFeedback(
          `Revoked access for ${sub.userEmail} (1/2 warnings — 1 more revoke will permanently block this account).`,
        );
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `subscriptions/${sub.userId}`);
    } finally {
      setBusyUid(null);
    }
  };

  const handleRestoreAccess = async (sub: SubscriptionDoc) => {
    setBusyUid(sub.userId);
    setFeedback(null);
    const renewedExpiry = Math.max(sub.expiresAtMs, Date.now() + 30 * 24 * 60 * 60 * 1000);

    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'subscriptions', sub.userId), {
        status: 'active',
        revokedReason: '',
        revokeCount: 0,
        expiresAtMs: renewedExpiry,
        updatedAt: serverTimestamp(),
      });

      payments
        .filter((p) => p.userId === sub.userId && p.utr === sub.utr)
        .forEach((p) => {
          batch.update(doc(db, 'payments', p.paymentId), {
            status: 'approved',
            revokedReason: '',
            updatedAt: serverTimestamp(),
          });
        });

      await batch.commit();
      setFeedback(`Restored monthly access and reset revocation count for ${sub.userEmail}.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `subscriptions/${sub.userId}`);
    } finally {
      setBusyUid(null);
    }
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-xs font-medium text-amber-400">
          <ShieldCheck className="w-4 h-4" />
          <span>Owner UTR Verification &amp; Revocation Console</span>
        </div>
        <h1 className="text-3xl font-bold text-white tracking-tight">Admin Panel</h1>
        <p className="text-sm text-slate-400">
          All ₹49 UPI UTR submissions auto-approve immediately. Verify UTR numbers against your
          PhonePe/Paytm statement and revoke fake UTRs in one click.
        </p>
      </div>

      {/* Unboxed KPI Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 py-5 px-6 bg-[#12161E] border border-white/[0.08] rounded-xl">
        <div className="space-y-1">
          <p className="text-xs text-slate-400">Active Subscribers</p>
          <p className="text-2xl font-bold text-emerald-400 font-mono tabular-nums">
            {stats.activeCount}
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-slate-400">Revoked / Blocked (2/2)</p>
          <p className="text-2xl font-bold text-red-400 font-mono tabular-nums">
            {stats.revokedCount}{' '}
            <span className="text-xs font-normal text-slate-400">
              ({stats.bannedCount} blocked)
            </span>
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-slate-400">Total Accounts</p>
          <p className="text-2xl font-bold text-white font-mono tabular-nums">
            {stats.total}
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-slate-400">Active Plan Value</p>
          <p className="text-2xl font-bold text-amber-400 font-mono tabular-nums">
            ₹{stats.verifiedRevenue}
          </p>
        </div>
      </div>

      {feedback && (
        <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-4 py-3 text-xs text-emerald-300 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{feedback}</span>
        </div>
      )}

      {/* Search + Segmented Status Filter */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by UTR, email, or name..."
            className="w-full pl-10 pr-4 py-2.5 rounded-lg bg-[#12161E] border border-white/10 focus:border-amber-400 focus:outline-none text-sm text-white placeholder:text-slate-500"
          />
        </div>

        <div className="flex items-center gap-1 p-1 bg-[#12161E] border border-white/[0.08] rounded-lg w-fit">
          {(
            [
              { id: 'all', label: 'All' },
              { id: 'active', label: 'Active' },
              { id: 'revoked', label: 'Revoked' },
              { id: 'banned', label: 'Blocked (2/2)' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilter(tab.id)}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                filter === tab.id
                  ? 'bg-amber-500 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Subscriber & UTR Table */}
      <section className="bg-[#12161E] border border-white/[0.08] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map((n) => (
              <div key={n} className="h-12 rounded bg-white/[0.04] animate-pulse" />
            ))}
          </div>
        ) : filteredSubs.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-400">
            No matching UTR submissions found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-white/[0.08] text-xs text-slate-400">
                  <th className="py-3.5 px-6 font-medium">User</th>
                  <th className="py-3.5 px-4 font-medium">Submitted UTR</th>
                  <th className="py-3.5 px-4 font-medium">App</th>
                  <th className="py-3.5 px-4 font-medium">Valid Until</th>
                  <th className="py-3.5 px-4 font-medium">Status</th>
                  <th className="py-3.5 px-6 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {filteredSubs.map((sub) => {
                  const isBusy = busyUid === sub.userId;
                  const isConfirming = revokingUid === sub.userId;
                  const revokeCount = sub.revokeCount ?? 0;
                  const isPermanentlyBlocked = revokeCount >= 2;

                  return (
                    <tr key={sub.userId} className="hover:bg-white/[0.02] align-top">
                      <td className="py-3.5 px-6">
                        <div className="font-medium text-white">{sub.userName}</div>
                        <div className="text-xs text-slate-400">{sub.userEmail}</div>
                      </td>
                      <td className="py-3.5 px-4 font-mono text-amber-300 font-medium select-all">
                        {sub.utr}
                      </td>
                      <td className="py-3.5 px-4 text-slate-300 capitalize">{sub.paymentApp}</td>
                      <td className="py-3.5 px-4 text-xs text-slate-300 tabular-nums whitespace-nowrap">
                        {formatDate(sub.expiresAtMs)}
                      </td>
                      <td className="py-3.5 px-4">
                        {sub.status === 'active' && !isPermanentlyBlocked ? (
                          <div className="space-y-0.5">
                            <span className="text-xs font-semibold text-emerald-400">Active</span>
                            {revokeCount === 1 && (
                              <p className="text-[11px] text-amber-400 font-medium">
                                Revokes: 1 / 2 (Final Warning)
                              </p>
                            )}
                          </div>
                        ) : (
                          <div className="space-y-0.5">
                            <span className="text-xs font-semibold text-red-400">
                              {isPermanentlyBlocked
                                ? `Permanently Blocked (${revokeCount}/2)`
                                : `Revoked (${revokeCount}/2)`}
                            </span>
                            {sub.revokedReason && (
                              <p className="text-[11px] text-slate-500 max-w-[180px] truncate">
                                {sub.revokedReason}
                              </p>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 px-6 text-right">
                        {sub.status === 'active' && !isPermanentlyBlocked ? (
                          isConfirming ? (
                            <div className="flex flex-col items-end gap-2 min-w-[230px]">
                              <input
                                type="text"
                                value={revokeReason}
                                onChange={(e) => setRevokeReason(e.target.value)}
                                maxLength={200}
                                placeholder="Reason for revocation"
                                className="w-full px-3 py-1.5 rounded bg-[#0B0D11] border border-red-500/40 text-xs text-white focus:outline-none"
                              />
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => setRevokingUid(null)}
                                  className="px-2.5 py-1 rounded text-xs text-slate-400 hover:text-white cursor-pointer"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => handleConfirmRevoke(sub)}
                                  className="px-3 py-1 rounded bg-red-600 hover:bg-red-500 text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
                                >
                                  {isBusy
                                    ? 'Revoking...'
                                    : revokeCount >= 1
                                      ? 'Confirm 2nd Revoke (Ban)'
                                      : 'Confirm Revoke'}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => {
                                setRevokeReason('Fake UTR / Payment not received');
                                setRevokingUid(sub.userId);
                              }}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-300 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer"
                            >
                              <Ban className="w-3.5 h-3.5" />
                              <span>{revokeCount >= 1 ? 'Revoke & Block (2/2)' : 'Revoke Access'}</span>
                            </button>
                          )
                        ) : (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => handleRestoreAccess(sub)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span>
                              {isBusy
                                ? 'Restoring...'
                                : isPermanentlyBlocked
                                  ? 'Unban & Restore'
                                  : 'Restore'}
                            </span>
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
