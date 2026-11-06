/**
 * Why the send loop is not sending right now, and until when. Kept in memory,
 * not in a column: after a restart the next tick meets the daily limit or the
 * quota error again and sets it again, which costs one request at most.
 *
 * The quota is per Resend account, so a wait holds every campaign, not one.
 */

export type WaitReason = 'daily_limit' | 'daily_quota' | 'monthly_quota';

export interface SendWait {
  reason: WaitReason;
  /** ISO time the loop tries again. */
  until: string;
}

let current: SendWait | null = null;

export function setSendWait(wait: SendWait | null): void {
  current = wait;
}

/** The wait in force at `now`, or null once it has run out. */
export function sendWait(now: number = Date.now()): SendWait | null {
  if (current && Date.parse(current.until) <= now) current = null;
  return current;
}

/** 00:00 UTC of the day after `now`: when Resend's daily quota resets. */
export function nextUtcMidnight(now: number): number {
  const day = new Date(now);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1);
}

/** 00:00 UTC of the day of `now`. */
export function utcMidnight(now: number): number {
  const day = new Date(now);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
}

/**
 * Resend's own count of emails used today (x-resend-daily-quota). It also
 * counts test sends, other apps on the same Resend account, and received
 * mail, which email_sends does not see.
 */
let resendUsed: { day: number; used: number } | null = null;

export function noteResendDailyUsed(used: number | null | undefined, now: number): void {
  if (used === null || used === undefined) return;
  resendUsed = { day: utcMidnight(now), used };
}

/** Resend's used count for the UTC day of `now`, or null when unknown or from another day. */
export function resendDailyUsed(now: number): number | null {
  return resendUsed && resendUsed.day === utcMidnight(now) ? resendUsed.used : null;
}

/** Test seam: forget the wait and Resend's count. */
export function resetSendState(): void {
  current = null;
  resendUsed = null;
}
