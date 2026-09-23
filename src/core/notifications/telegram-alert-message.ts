import type { ClaimedAlertDelivery } from '../../db/repositories/alert-repository.js';

const severityPresentation: Record<string, { emoji: string; label: string }> = {
  info: { emoji: '🔵', label: '提醒' },
  warning: { emoji: '🟠', label: '警告' },
  critical: { emoji: '🔴', label: '严重告警' },
  emergency: { emoji: '🚨', label: '紧急告警' },
};

function lineValue(message: string, label: string): string | undefined {
  const prefix = `${label}:`;
  const line = message.split('\n').find((candidate) => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function ruleName(title: string): string {
  return title.replace(/^\[[^\]]+\]\s+(?:Alert|Reminder):\s*/u, '').trim() || title;
}

function compactTarget(target: string): string {
  if (/^0x[0-9a-f]{40}$/iu.test(target)) return `${target.slice(0, 8)}…${target.slice(-6)}`;
  return target.length > 64 ? `${target.slice(0, 61)}…` : target;
}

function beijingTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (!Number.isFinite(date.getTime())) return isoTimestamp;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date).replace('/', '-');
}

export function formatTelegramAlert(job: ClaimedAlertDelivery): string {
  const severity = severityPresentation[job.severity] ?? { emoji: '⚠️', label: '告警' };
  const repeated = /\bReminder:\s*/u.test(job.title);
  const target = lineValue(job.message, 'Target');
  const currentValue = lineValue(job.message, 'Current value') ?? job.currentValue;
  return [
    `${severity.emoji} ${severity.label}${repeated ? '再次提醒' : ''}｜${ruleName(job.title)}`,
    ...(target === undefined ? [] : [`对象：${compactTarget(target)}`]),
    ...(currentValue === null ? [] : [`当前：${currentValue}`]),
    `时间：${beijingTime(job.observedAt)}（北京时间）`,
  ].join('\n');
}
