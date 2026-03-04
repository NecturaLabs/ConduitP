import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Normalise a SQLite datetime string ("YYYY-MM-DD HH:MM:SS") to ISO 8601 with
 * a trailing Z suffix. Already-normalised strings are returned as-is.
 */
export function normalizeDate(dateStr: string): string {
  if (/[Zz+\-]\d{2}:\d{2}$|[Zz]$/.test(dateStr)) return dateStr;
  return dateStr.replace(' ', 'T') + 'Z';
}

export function relativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return 'never';
  const normalised = normalizeDate(dateStr);
  const then = new Date(normalised).getTime();
  if (Number.isNaN(then)) return 'never';

  const now = Date.now();
  const diff = now - then;

  const seconds = Math.floor(diff / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

export function formatCost(n: number): string {
  if (n === 0) return '$0.00';
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

export function getInstanceLabel(instanceType?: string): string {
  if (instanceType === 'claude-code') return 'Claude Code';
  return 'OpenCode';
}
