import type { Timestamp } from 'firebase/firestore';

export type PaymentApp = 'phonepe' | 'paytm' | 'upi';
export type SubscriptionStatus = 'active' | 'revoked';
export type IsolationMode = 'balanced' | 'maximum' | 'natural';
export type AudioExportFormat = 'wav' | 'mp3';

export interface SubscriptionDoc {
  userId: string;
  userEmail: string;
  userName: string;
  utr: string;
  paymentApp: PaymentApp;
  upiId: string;
  amount: number;
  plan: string;
  status: SubscriptionStatus;
  revokedReason: string;
  revokeCount?: number;
  expiresAtMs: number;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface PaymentRecordDoc {
  paymentId: string;
  userId: string;
  userEmail: string;
  userName: string;
  utr: string;
  paymentApp: PaymentApp;
  upiId: string;
  amount: number;
  status: 'approved' | 'revoked';
  revokedReason: string;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface ProcessingJobDoc {
  jobId: string;
  userId: string;
  fileName: string;
  mediaType: 'audio' | 'video';
  mode: IsolationMode;
  durationSec: number;
  noiseReductionDb: number;
  speechPreservationPct: number;
  createdAt: Timestamp | null;
}

export interface DenoiseApiResponse {
  jobId: string;
  mediaType: 'audio' | 'video';
  outputFileName: string;
  mimeType: string;
  durationSec: number;
  speechDurationSec: number;
  noiseReductionDb: number;
  speechPreservationPct: number;
  originalPeaks: number[];
  cleanedPeaks: number[];
  streamUrl: string;
  downloadUrl: string;
  cleanedAudioUrl?: string;
  isSyncedVideoFallback?: boolean;
}
