import { useEffect, useMemo, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import {
  AudioWaveform,
  Ban,
  CheckCircle2,
  Mail,
  RotateCcw,
  Search,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { ADMIN_EMAIL, db, handleFirestoreError, OperationType } from '../firebase';
import type {
  PaymentRecordDoc,
  ProcessingJobDoc,
  SubscriptionDoc,
  UserProfileDoc,
} from '../types';

function formatDate(ms: number): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(ms));
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

type AdminSection = 'users' | 'activity' | 'legacy';

export function AdminPanel() {
  const [users, setUsers] = useState<UserProfileDoc[]>([]);
  const [jobs, setJobs] = useState<ProcessingJobDoc[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionDoc[]>([]);
  const [payments, setPayments] = useState<PaymentRecordDoc[]>([]);
  const [loading, setLoading] = useState(true);

  const [section, setSection] = useState<AdminSection>('users');
  const [search, setSearch] = useState('');
  const [subFilter, setSubFilter] = useState<'all' | 'active' | 'revoked' | 'banned'>('all');

  const [revokingUid, setRevokingUid] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState('Abuse / Policy violation');
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    let usersLoaded = false;
    let jobsLoaded = false;
    let subsLoaded = false;
    let payLoaded = false;

    const checkAllLoaded = () => {
      if (usersLoaded && jobsLoaded && subsLoaded && payLoaded) {
        setLoading(false);
      }
    };

    const unsubUsers = onSnapshot(
      collection(db, 'users'),
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as UserProfileDoc)
          .sort((a, b) => (b.updatedAt?.toMillis() ?? 0) - (a.updatedAt?.toMillis() ?? 0));
        setUsers(list);
        usersLoaded = true;
        checkAllLoaded();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'users'),
    );

    const unsubJobs = onSnapshot(
      collection(db, 'processingJobs'),
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as ProcessingJobDoc)
          .sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0));
        setJobs(list);
        jobsLoaded = true;
        checkAllLoaded();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'processingJobs'),
    );

    const unsubSubs = onSnapshot(
      collection(db, 'subscriptions'),
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as SubscriptionDoc)
          .sort((a, b) => (b.updatedAt?.toMillis() ?? 0) - (a.updatedAt?.toMillis() ?? 0));
        setSubscriptions(list);
        subsLoaded = true;
        checkAllLoaded();
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
        checkAllLoaded();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'payments'),
    );

    return () => {
      unsubUsers();
      unsubJobs();
      unsubSubs();
      unsubPay();
    };
  }, []);

  const userMap = useMemo(() => {
    const map = new Map<string, UserProfileDoc>();
    users.forEach((u) => map.set(u.uid, u));
    return map;
  }, [users]);

  const subByUid = useMemo(() => {
    const map = new Map<string, SubscriptionDoc>();
    subscriptions.forEach((s) => map.set(s.userId, s));
    return map;
  }, [subscriptions]);

  const jobCountByUid = useMemo(() => {
    const counts = new Map<string, number>();
    jobs.forEach((j) => {
      counts.set(j.userId, (counts.get(j.userId) ?? 0) + 1);
    });
    return counts;
  }, [jobs]);

  const stats = useMemo(() => {
    const dayAgoMs = Date.now() - 24 * 60 * 60 * 1000;
    const activeLast24h = users.filter((u) => (u.updatedAt?.toMillis() ?? 0) >= dayAgoMs).length;
    const bannedCount = subscriptions.filter((s) => (s.revokeCount ?? 0) >= 2).length;
    return {
      totalUsers: users.length,
      activeLast24h,
      totalJobs: jobs.length,
      bannedCount,
    };
  }, [users, jobs, subscriptions]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.email.toLowerCase().includes(q) ||
        u.displayName.toLowerCase().includes(q) ||
        u.uid.toLowerCase().includes(q),
    );
  }, [users, search]);

  const filteredJobs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter((j) => {
      const owner = userMap.get(j.userId);
      return (
        j.fileName.toLowerCase().includes(q) ||
        (owner?.email ?? '').toLowerCase().includes(q) ||
        (owner?.displayName ?? '').toLowerCase().includes(q)
      );
    });
  }, [jobs, search, userMap]);

  const filteredSubs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return subscriptions.filter((s) => {
      const count = s.revokeCount ?? 0;
      if (subFilter === 'active' && (s.status !== 'active' || count >= 2)) return false;
      if (subFilter === 'revoked' && s.status !== 'revoked') return false;
      if (subFilter === 'banned' && count < 2) return false;
      if (!q) return true;
      return (
        s.utr.toLowerCase().includes(q) ||
        s.userEmail.toLowerCase().includes(q) ||
        s.userName.toLowerCase().includes(q)
      );
    });
  }, [subscriptions, search, subFilter]);

  const handleConfirmRevoke = async (sub: SubscriptionDoc) => {
    setBusyUid(sub.userId);
    setFeedback(null);
    const reason = revokeReason.trim().slice(0, 200) || 'Abuse / Policy violation';
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
          `Blocked ${sub.userEmail} (${nextRevokeCount}/2) — Account is now permanently blocked from using Noise Cleaner AI.`,
        );
      } else {
        setFeedback(`Updated warning count for ${sub.userEmail} (${nextRevokeCount}/2).`);
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
      setFeedback(`Unbanned and restored access for ${sub.userEmail}.`);
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
          <span>Owner Analytics &amp; User Directory</span>
        </div>
        <h1 className="text-3xl font-bold text-white tracking-tight">Admin Panel</h1>
        <p className="text-sm text-slate-400">
          Live count of everyone signing in with Gmail, their cleaned audio/video activity, and
          account controls.
        </p>
      </div>

      {/* KPI Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 py-5 px-6 bg-[#12161E] border border-white/[0.08] rounded-xl">
        <div className="space-y-1">
          <p className="text-xs text-slate-400">Total Users (Gmail)</p>
          <p className="text-2xl font-bold text-emerald-400 font-mono tabular-nums">
            {stats.totalUsers}
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-slate-400">Active (Last 24h)</p>
          <p className="text-2xl font-bold text-amber-400 font-mono tabular-nums">
            {stats.activeLast24h}
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-slate-400">Total Files Cleaned</p>
          <p className="text-2xl font-bold text-white font-mono tabular-nums">
            {stats.totalJobs}
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-slate-400">Blocked Accounts</p>
          <p className="text-2xl font-bold text-red-400 font-mono tabular-nums">
            {stats.bannedCount}
          </p>
        </div>
      </div>

      {feedback && (
        <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-4 py-3 text-xs text-emerald-300 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{feedback}</span>
        </div>
      )}

      {/* Search + Section Tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={
              section === 'users'
                ? 'Search by Gmail or name...'
                : section === 'activity'
                  ? 'Search by file name, Gmail, or user...'
                  : 'Search by UTR, Gmail, or name...'
            }
            className="w-full pl-10 pr-4 py-2.5 rounded-lg bg-[#12161E] border border-white/10 focus:border-amber-400 focus:outline-none text-sm text-white placeholder:text-slate-500"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1 p-1 bg-[#12161E] border border-white/[0.08] rounded-lg w-fit">
          <button
            type="button"
            onClick={() => setSection('users')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              section === 'users'
                ? 'bg-amber-500 text-slate-950 font-semibold'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>Users ({users.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setSection('activity')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              section === 'activity'
                ? 'bg-amber-500 text-slate-950 font-semibold'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <AudioWaveform className="w-3.5 h-3.5" />
            <span>Cleaned Files ({jobs.length})</span>
          </button>
          {subscriptions.length > 0 && (
            <button
              type="button"
              onClick={() => setSection('legacy')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                section === 'legacy'
                  ? 'bg-amber-500 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Past UTR / Bans ({subscriptions.length})
            </button>
          )}
        </div>
      </div>

      {/* Section 1: All Signed-In Users & Gmail IDs */}
      {section === 'users' && (
        <section className="bg-[#12161E] border border-white/[0.08] rounded-xl overflow-hidden">
          {loading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map((n) => (
                <div key={n} className="h-12 rounded bg-white/[0.04] animate-pulse" />
              ))}
            </div>
          ) : filteredUsers.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-400">
              No signed-in users found yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-white/[0.08] text-xs text-slate-400">
                    <th className="py-3.5 px-6 font-medium">User</th>
                    <th className="py-3.5 px-4 font-medium">Gmail ID</th>
                    <th className="py-3.5 px-4 font-medium text-right">Files Cleaned</th>
                    <th className="py-3.5 px-4 font-medium">Joined</th>
                    <th className="py-3.5 px-4 font-medium">Last Active</th>
                    <th className="py-3.5 px-6 font-medium text-right">Access</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06]">
                  {filteredUsers.map((u) => {
                    const isOwnerAccount = u.email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
                    const sub = subByUid.get(u.uid);
                    const isBanned = !isOwnerAccount && (sub?.revokeCount ?? 0) >= 2;
                    const filesCleaned = jobCountByUid.get(u.uid) ?? 0;

                    return (
                      <tr key={u.uid} className="hover:bg-white/[0.02]">
                        <td className="py-3.5 px-6">
                          <div className="flex items-center gap-3">
                            {u.photoURL ? (
                              <img
                                src={u.photoURL}
                                alt={u.displayName}
                                referrerPolicy="no-referrer"
                                className="w-8 h-8 rounded-full object-cover border border-white/10 shrink-0"
                              />
                            ) : (
                              <div className="w-8 h-8 rounded-full bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-xs font-bold text-amber-300 shrink-0">
                                {(u.displayName || u.email || 'U').charAt(0).toUpperCase()}
                              </div>
                            )}
                            <span className="font-medium text-white truncate max-w-[180px]">
                              {u.displayName}
                            </span>
                          </div>
                        </td>
                        <td className="py-3.5 px-4">
                          <div className="inline-flex items-center gap-1.5 text-slate-200 select-all">
                            <Mail className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                            <span>{u.email}</span>
                          </div>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-white font-semibold">
                          {filesCleaned}
                        </td>
                        <td className="py-3.5 px-4 text-xs text-slate-400 tabular-nums whitespace-nowrap">
                          {formatTimestamp(u.createdAt)}
                        </td>
                        <td className="py-3.5 px-4 text-xs text-slate-300 tabular-nums whitespace-nowrap">
                          {formatTimestamp(u.updatedAt)}
                        </td>
                        <td className="py-3.5 px-6 text-right whitespace-nowrap">
                          {isOwnerAccount ? (
                            <span className="text-xs font-semibold text-amber-400">Owner</span>
                          ) : isBanned ? (
                            <span className="text-xs font-semibold text-red-400">Blocked</span>
                          ) : (
                            <span className="text-xs font-semibold text-emerald-400">
                              Free Active
                            </span>
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
      )}

      {/* Section 2: All Cleaned Files Activity Feed */}
      {section === 'activity' && (
        <section className="bg-[#12161E] border border-white/[0.08] rounded-xl overflow-hidden">
          {loading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map((n) => (
                <div key={n} className="h-12 rounded bg-white/[0.04] animate-pulse" />
              ))}
            </div>
          ) : filteredJobs.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-400">
              No files have been processed yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-white/[0.08] text-xs text-slate-400">
                    <th className="py-3.5 px-6 font-medium">User / Gmail</th>
                    <th className="py-3.5 px-4 font-medium">File Name</th>
                    <th className="py-3.5 px-4 font-medium">Type</th>
                    <th className="py-3.5 px-4 font-medium">Mode</th>
                    <th className="py-3.5 px-4 font-medium text-right">Noise Cut</th>
                    <th className="py-3.5 px-6 font-medium text-right">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06]">
                  {filteredJobs.map((job) => {
                    const owner = userMap.get(job.userId);
                    return (
                      <tr key={job.jobId} className="hover:bg-white/[0.02]">
                        <td className="py-3.5 px-6">
                          <div className="font-medium text-white">
                            {owner?.displayName || 'User'}
                          </div>
                          <div className="text-xs text-slate-400">
                            {owner?.email || job.userId}
                          </div>
                        </td>
                        <td className="py-3.5 px-4 text-slate-200 max-w-[220px] truncate">
                          {job.fileName}
                        </td>
                        <td className="py-3.5 px-4 text-slate-400 capitalize">{job.mediaType}</td>
                        <td className="py-3.5 px-4 text-slate-300 capitalize">{job.mode}</td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-emerald-400">
                          -{job.noiseReductionDb.toFixed(1)} dB
                        </td>
                        <td className="py-3.5 px-6 text-right text-xs text-slate-400 tabular-nums whitespace-nowrap">
                          {formatTimestamp(job.createdAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Section 3: Legacy UTR & Ban Management */}
      {section === 'legacy' && (
        <div className="space-y-4">
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
                onClick={() => setSubFilter(tab.id)}
                className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  subFilter === tab.id
                    ? 'bg-amber-500 text-slate-950 font-semibold'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <section className="bg-[#12161E] border border-white/[0.08] rounded-xl overflow-hidden">
            {filteredSubs.length === 0 ? (
              <div className="p-10 text-center text-sm text-slate-400">
                No matching legacy UTR records found.
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
                          <td className="py-3.5 px-4 text-slate-300 capitalize">
                            {sub.paymentApp}
                          </td>
                          <td className="py-3.5 px-4 text-xs text-slate-300 tabular-nums whitespace-nowrap">
                            {formatDate(sub.expiresAtMs)}
                          </td>
                          <td className="py-3.5 px-4">
                            {sub.status === 'active' && !isPermanentlyBlocked ? (
                              <div className="space-y-0.5">
                                <span className="text-xs font-semibold text-emerald-400">
                                  Active
                                </span>
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
                                    placeholder="Reason"
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
                                        ? 'Updating...'
                                        : revokeCount >= 1
                                          ? 'Confirm Block (2/2)'
                                          : 'Confirm Revoke'}
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => {
                                    setRevokeReason('Abuse / Policy violation');
                                    setRevokingUid(sub.userId);
                                  }}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-300 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer"
                                >
                                  <Ban className="w-3.5 h-3.5" />
                                  <span>
                                    {revokeCount >= 1 ? 'Revoke & Block (2/2)' : 'Revoke Access'}
                                  </span>
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
      )}
    </div>
  );
}
