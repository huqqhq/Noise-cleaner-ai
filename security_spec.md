# Noiser Remover AI — Firestore Security Specification (Phase 0)

## 1. Data Invariants
1. **Mandatory Verified Identity**: Every read and write requires a signed-in user with `request.auth.token.email_verified == true`.
2. **PII Isolation**: `users/{userId}` and `subscriptions/{userId}` contain email addresses and are readable only by `isOwner(userId)` or `isBootstrapAdmin()` (`sanjeeta1320@gmail.com` with `email_verified == true`).
3. **Single-Use UTR Atomicity**: Creating or renewing a `subscriptions/{userId}` document with a UTR MUST atomically create the corresponding `utrClaims/{utr}` document (`existsAfter`), and `utrClaims` documents are immutable (no updates or deletes) so a fake or already-used UTR cannot be recycled.
4. **Revocation Integrity & 2-Strike Permanent Ban**: Only the admin (`sanjeeta1320@gmail.com`) may transition a subscription to `revoked`, modify `revokedReason`, or modify `revokeCount`. A revoked user cannot bypass revocation by reusing their old UTR (`incoming().utr != existing().utr`) or resetting `revokeCount`. Once `revokeCount >= 2`, the user is permanently blocked from updating `subscriptions/{userId}`, creating `utrClaims`, creating `payments`, or creating `processingJobs`.
5. **Strict Financial Constants**: `amount` MUST equal `49`, `upiId` MUST equal `'9990232974@axl'`, and `plan` MUST equal `'monthly_49'`.
6. **Verified Non-Banned Gate for Processing Jobs**: Creating a `processingJobs/{jobId}` record requires a verified, non-banned user (`isAdmin() || isNotBanned()`).
7. **Temporal Integrity**: `createdAt` must equal `request.time` on creation and remain immutable on update; `updatedAt` must equal `request.time` on both create and update.
8. **Zero Blanket List Queries**: Every `allow list` checks `resource.data.userId == request.auth.uid || isBootstrapAdmin()` with zero `get()`/`exists()` calls inside `list`.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated Read** on `/subscriptions/victimUid` -> MUST DENY.
2. **Unverified Email Spoof** (`email: 'sanjeeta1320@gmail.com'`, `email_verified: false`) listing `/subscriptions` -> MUST DENY.
3. **Cross-User PII Leak**: User A calling `get` on `/users/userB` or `/subscriptions/userB` -> MUST DENY.
4. **Shadow / Ghost Field Injection**: Creating `/subscriptions/userA` with extra key `isAdmin: true` -> MUST DENY (`hasOnly`).
5. **Identity Spoofing**: User A creating `/payments/pay1` with `userId: 'userB'` -> MUST DENY.
6. **Amount / UPI Tampering**: Creating `/subscriptions/userA` with `amount: 0` or `upiId: 'hacker@upi'` -> MUST DENY.
7. **Orphaned Subscription Without UTR Claim**: Creating `/subscriptions/userA` without atomically creating `/utrClaims/{utr}` in the same batch -> MUST DENY (`existsAfter`).
8. **UTR Recycling / Permanently Banned Resubmission**: Revoked User A updating `/subscriptions/userA` with the SAME revoked `utr`, attempting to reset `revokeCount: 0`, or submitting a new UTR once `revokeCount >= 2` -> MUST DENY.
9. **Non-Admin Revocation Attack**: User A attempting to update `/subscriptions/userB` to `status: 'revoked'` -> MUST DENY.
10. **Processing Job By Banned User**: Permanently banned User (`revokeCount >= 2`) creating `/processingJobs/job1` -> MUST DENY.
11. **Path ID Poisoning**: Creating `/payments/<200-char-invalid-id!@#>` -> MUST DENY (`isValidId`).
12. **Client-Forged Timestamp / Value Poisoning**: Creating `/users/userA` with backdated `createdAt` or a 10KB `displayName` string -> MUST DENY.
