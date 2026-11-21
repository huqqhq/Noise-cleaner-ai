import { useEffect, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { doc, getDoc, onSnapshot, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { Ban, LogOut } from 'lucide-react';
import {
  ADMIN_EMAIL,
  auth,
  db,
  googleProvider,
  handleFirestoreError,
  OperationType,
} from './firebase';
import type { SubscriptionDoc } from './types';
import { AdminPanel } from './components/AdminPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { HistoryView } from './components/HistoryView';
import { LoginGate } from './components/LoginGate';
import { NoiseRemoverStudio } from './components/NoiseRemoverStudio';

type ActiveTab = 'studio' | 'history' | 'admin';

function AppShell() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [subscription, setSubscription] = useState<SubscriptionDoc | null>(null);
  const [subReady, setSubReady] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>('studio');

  // 1. Observe Firebase Google Auth state
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);

      if (!nextUser) {
        setSubscription(null);
        setSubReady(false);
        setActiveTab('studio');
        return;
      }

      // Sync verified user profile cleanly into users/{uid}
      try {
        const userRef = doc(db, 'users', nextUser.uid);
        const snap = await getDoc(userRef);
        const safeName = (
          nextUser.displayName ||
          nextUser.email?.split('@')[0] ||
          'User'
        ).slice(0, 120);
        const safeEmail = (nextUser.email || '').slice(0, 160);
        const safePhoto = (nextUser.photoURL || '').slice(0, 500);

        if (!snap.exists()) {
          await setDoc(userRef, {
            uid: nextUser.uid,
            displayName: safeName,
            email: safeEmail,
            photoURL: safePhoto,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          await updateDoc(userRef, {
            displayName: safeName,
            email: safeEmail,
            photoURL: safePhoto,
            updatedAt: serverTimestamp(),
          });
        }
      } catch (err) {
        console.error('Profile sync warning:', err);
      }
    });

    return () => unsub();
  }, []);

  // 2. Real-time Subscription Listener (Instant Auto-Approve & Instant Admin Revocation)
  useEffect(() => {
    if (!authReady || !user) return;
    setSubReady(false);

    const subRef = doc(db, 'subscriptions', user.uid);
    const unsub = onSnapshot(
      subRef,
      (snap) => {
        if (snap.exists()) {
          setSubscription(snap.data() as SubscriptionDoc);
        } else {
          setSubscription(null);
        }
        setSubReady(true);
      },
      (err) => {
        handleFirestoreError(err, OperationType.GET, `subscriptions/${user.uid}`);
      },
    );

    return () => unsub();
  }, [authReady, user]);

  const handleGoogleSignIn = async () => {
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Google sign-in failed.';
      if (msg.includes('popup-closed-by-user')) {
        setAuthError('Google sign-in window was closed. Please try again to continue.');
      } else {
        setAuthError(msg);
      }
    }
  };

  const handleSignOut = async () => {
    await signOut(auth);
  };

  // Loading auth initialization
  if (!authReady) {
    return (
      <div className="min-h-screen bg-[#0B0D11] flex items-center justify-center">
        <div className="text-sm text-slate-400">Loading Noise Remover AI...</div>
      </div>
    );
  }

  // Mandatory Google Login Gate — cannot proceed without signing in
  if (!user) {
    return <LoginGate onGoogleSignIn={handleGoogleSignIn} authError={authError} />;
  }

  const isAdmin =
    Boolean(user.emailVerified) && user.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase();

  const revokeCount = subscription?.revokeCount ?? 0;
  const isPermanentlyBanned = !isAdmin && revokeCount >= 2;

  const hasActiveSubscription =
    isAdmin ||
    (!isPermanentlyBanned &&
      Boolean(
        subscription &&
          subscription.status === 'active' &&
          subscription.expiresAtMs > Date.now(),
      ));

  return (
    <div className="min-h-screen bg-[#0B0D11] text-slate-100 flex flex-col">
      {/* Top Bar Contract: Single-row 3-zone header separated by gap-8 */}
      <header className="w-full border-b border-white/[0.08] bg-[#0B0D11]">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between gap-8">
          {/* Zone 1: Single-line Brand Wordmark */}
          <button
            type="button"
            onClick={() => {
              if (!isPermanentlyBanned) setActiveTab('studio');
            }}
            className="text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            Noise Remover AI
          </button>

          {/* Zone 2: Clean Typography Nav Links */}
          {!isPermanentlyBanned ? (
            <nav className="flex items-center gap-6 text-sm font-medium">
              <button
                type="button"
                onClick={() => setActiveTab('studio')}
                className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTab === 'studio'
                    ? 'text-amber-400 border-b-2 border-amber-400'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Studio
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('history')}
                className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTab === 'history'
                    ? 'text-amber-400 border-b-2 border-amber-400'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                History
              </button>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setActiveTab('admin')}
                  className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    activeTab === 'admin'
                      ? 'text-amber-400 border-b-2 border-amber-400'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Admin Panel
                </button>
              )}
            </nav>
          ) : (
            <span className="text-xs font-semibold text-red-400">Account Permanently Blocked</span>
          )}

          {/* Zone 3: User Account & Sign Out */}
          <div className="flex items-center gap-3 shrink-0">
            <span className="hidden md:inline text-xs text-slate-400 truncate max-w-[160px]">
              {user.displayName || user.email}
            </span>
            <button
              type="button"
              onClick={handleSignOut}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 hover:bg-white/[0.06] text-xs font-medium text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign out</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-10">
        {!subReady ? (
          <div className="space-y-4">
            <div className="h-8 w-56 rounded bg-white/[0.05] animate-pulse" />
            <div className="h-64 w-full rounded-xl bg-white/[0.03] border border-white/[0.06] animate-pulse" />
          </div>
        ) : isPermanentlyBanned ? (
          <section
            role="alert"
            className="max-w-xl mx-auto my-8 bg-[#12161E] border border-red-500/30 rounded-2xl p-8 text-center space-y-5"
          >
            <div className="w-14 h-14 mx-auto rounded-full bg-red-500/15 border border-red-500/30 flex items-center justify-center">
              <Ban className="w-7 h-7 text-red-400" />
            </div>
            <div className="space-y-2">
              <h1 className="text-2xl font-bold text-white tracking-tight">
                Account Permanently Blocked
              </h1>
              <p className="text-sm text-slate-300 leading-relaxed">
                Your plan was revoked <span className="font-semibold text-red-400">{revokeCount} times</span>{' '}
                by the administrator. You can no longer submit UTR numbers or use Noise Remover AI.
              </p>
            </div>
            <div className="rounded-xl bg-[#0B0D11] border border-white/[0.08] p-4 text-left space-y-1.5 text-xs">
              <div className="flex items-center justify-between gap-4">
                <span className="text-slate-400">Signed-in account</span>
                <span className="text-slate-200 font-medium truncate">{user.email}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-slate-400">Revocations</span>
                <span className="text-red-400 font-mono font-semibold">{revokeCount} / 2</span>
              </div>
              {subscription?.revokedReason && (
                <div className="pt-1.5 border-t border-white/[0.06] text-slate-400">
                  Last reason:{' '}
                  <span className="text-red-300">{subscription.revokedReason}</span>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-white/10 hover:bg-white/15 text-white text-sm font-semibold transition-colors cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              <span>Sign out</span>
            </button>
          </section>
        ) : activeTab === 'admin' && isAdmin ? (
          <AdminPanel />
        ) : activeTab === 'history' ? (
          <HistoryView user={user} onBackToStudio={() => setActiveTab('studio')} />
        ) : (
          <NoiseRemoverStudio
            user={user}
            subscription={subscription}
            hasActiveSubscription={hasActiveSubscription}
            isAdmin={isAdmin}
          />
        )}
      </main>

      {/* Quiet Minimal Footer */}
      <footer className="border-t border-white/[0.06] py-5 px-6">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500">
          <span>Noise Remover AI · Neural Speech Isolation Studio</span>
          <span>Support UPI: 9990232974@axl · ₹49 Monthly Plan</span>
        </div>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  );
}
