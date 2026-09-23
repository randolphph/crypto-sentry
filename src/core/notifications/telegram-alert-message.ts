import type { ClaimedAlertDelivery } from '../../db/repositories/alert-repository.js';

const severityPresentation: Record<string, { emoji: string; label: string }> = {
  info: { emoji: '🔵', label: '提醒' },
  warning: { emoji: '🟠', label: '警告' },
  critical: { emoji: '🔴', label: '严重告警' },
  emergency: { emoji: '🚨', label: '紧急告警' },
};

const uniswapMetricNames: Record<string, string> = {
  in_range: '价格区间状态',
  current_tick: '当前价格点位',
  tick_lower: '区间下界',
  tick_upper: '区间上界',
  distance_to_lower_tick: '距区间下界',
  distance_to_upper_tick: '距区间上界',
  distance_to_nearest_boundary_percent: '距最近边界',
  liquidity: '流动性',
  token0_amount: '币种 0 数量',
  token1_amount: '币种 1 数量',
  fees_owed_token0: '币种 0 待领手续费',
  fees_owed_token1: '币种 1 待领手续费',
  position_value_usd: '仓位价值',
  fees_value_usd: '待领手续费',
  position_closed: '仓位状态',
  position_count: '仓位数',
  in_range_count: '区间内仓位数',
  out_of_range_count: '区间外仓位数',
  failed_position_count: '读取失败仓位数',
  aggregate_value_usd: '仓位总价值',
  aggregate_fees_usd: '待领手续费总额',
  token0_price: '币种 0 价格',
  token1_price: '币种 1 价格',
  active_liquidity: '活跃流动性',
  tvl_token0: '币种 0 锁仓量',
  tvl_token1: '币种 1 锁仓量',
  tvl_usd: '总锁仓价值',
  volume_token0: '币种 0 成交量',
  volume_token1: '币种 1 成交量',
  volume_usd: '成交额',
  volume_change_percent: '成交额变化',
  swap: '发生交易',
  mint: '新增流动性',
  burn: '移除流动性',
  fee_collection: '领取手续费',
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

function lineEntries(message: string, label: string): Record<string, string> {
  const value = lineValue(message, label);
  if (value === undefined) return {};
  return Object.fromEntries(value.split(', ').flatMap((entry) => {
    const separator = entry.indexOf('=');
    return separator < 1 ? [] : [[entry.slice(0, separator), entry.slice(separator + 1)]];
  }));
}

function conciseNumber(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value);
  if (match === null) return value;
  const [, sign, integer = '', fraction] = match;
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  if (fraction === undefined) return `${sign}${grouped}`;
  const conciseFraction = fraction.slice(0, 6).replace(/0+$/u, '');
  return `${sign}${grouped}${conciseFraction.length === 0 ? '' : `.${conciseFraction}`}`;
}

function localizedValue(currentValue: string, labels: Record<string, string>, metric: string): string {
  const separator = currentValue.lastIndexOf(' ');
  const rawValue = separator < 0 ? currentValue : currentValue.slice(0, separator);
  const unit = separator < 0 ? '' : currentValue.slice(separator + 1);
  if (unit === 'boolean') {
    if (metric === 'in_range') return rawValue === 'true' ? '已进入价格区间' : '已离开价格区间';
    if (metric === 'position_closed') return rawValue === 'true' ? '已关闭' : '运行中';
    return rawValue === 'true' ? '是' : rawValue === 'false' ? '否' : rawValue;
  }
  const value = conciseNumber(rawValue);
  if (unit === 'USD') return `$${value}`;
  if (unit === 'percent') return `${value}%`;
  if (unit === 'positions') return `${value} 个`;
  if (unit === 'tick') return value;
  if (unit === 'token0') return `${value} ${labels.token0Symbol ?? 'Token0'}`;
  if (unit === 'token1') return `${value} ${labels.token1Symbol ?? 'Token1'}`;
  return unit.length === 0 || unit === 'liquidity' ? value : `${value} ${unit}`;
}

function localizedUniswapMetric(metric: string, labels: Record<string, string>): string {
  const name = uniswapMetricNames[metric] ?? metric;
  return name
    .replace('币种 0', labels.token0Symbol ?? '币种 0')
    .replace('币种 1', labels.token1Symbol ?? '币种 1');
}

function formatUniswapAlert(
  job: ClaimedAlertDelivery,
  severity: { emoji: string; label: string },
  repeated: boolean,
): string | undefined {
  const metric = lineValue(job.message, 'Metric');
  const labels = lineEntries(job.message, 'Labels');
  if (metric === undefined || uniswapMetricNames[metric] === undefined || labels.version === undefined) return undefined;

  const current = lineValue(job.message, 'Current value') ?? job.currentValue;
  const pair = labels.token0Symbol !== undefined && labels.token1Symbol !== undefined
    ? `${labels.token0Symbol}/${labels.token1Symbol}` : undefined;
  const version = labels.version.toUpperCase();
  const isPool = labels.resourceId !== undefined && labels.tokenId === undefined;
  const subject = isPool ? '池子' : labels.tokenId === undefined ? 'LP 钱包' : 'LP';
  const stateTitle = metric === 'in_range' && current !== null
    ? localizedValue(current, labels, metric)
    : metric === 'position_closed' && current !== null
      ? `仓位${localizedValue(current, labels, metric)}`
      : localizedUniswapMetric(metric, labels);
  const identity = [pair, version, labels.tokenId === undefined ? undefined : `#${labels.tokenId}`]
    .filter((value): value is string => value !== undefined).join(' · ');
  const target = lineValue(job.message, 'Target');

  return [
    `${severity.emoji} ${severity.label}${repeated ? '（再次提醒）' : ''}｜${subject} ${stateTitle}`,
    ...(identity.length > 0 ? [`${isPool ? '池子' : '仓位'}：${identity}`]
      : target === undefined ? [] : [`对象：${compactTarget(target)}`]),
    ...(current === null || metric === 'in_range' || metric === 'position_closed'
      ? [] : [`当前：${localizedValue(current, labels, metric)}`]),
    `时间：${beijingTime(job.observedAt)}（北京时间）`,
  ].join('\n');
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
  const uniswapAlert = formatUniswapAlert(job, severity, repeated);
  if (uniswapAlert !== undefined) return uniswapAlert;
  const target = lineValue(job.message, 'Target');
  const currentValue = lineValue(job.message, 'Current value') ?? job.currentValue;
  return [
    `${severity.emoji} ${severity.label}${repeated ? '再次提醒' : ''}｜${ruleName(job.title)}`,
    ...(target === undefined ? [] : [`对象：${compactTarget(target)}`]),
    ...(currentValue === null ? [] : [`当前：${currentValue}`]),
    `时间：${beijingTime(job.observedAt)}（北京时间）`,
  ].join('\n');
}
