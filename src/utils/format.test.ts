import { describe, expect, it } from 'vitest';
import { dueText, errorText } from './format';

describe('saying when something is due', () => {
  // In the middle of the day: the time of day must not change the answer.
  const now = new Date(2026, 9, 8, 15, 30);

  it('says today for today and for everything that is overdue', () => {
    expect(dueText('2026-10-08', now)).toBe('今天');
    expect(dueText('2026-10-07', now)).toBe('今天');
    expect(dueText('2025-01-01', now)).toBe('今天');
  });

  it('says tomorrow, and then counts the days', () => {
    expect(dueText('2026-10-09', now)).toBe('明天');
    expect(dueText('2026-10-10', now)).toBe('2 天后');
    expect(dueText('2026-10-22', now)).toBe('14 天后');
  });

  it('counts the calendar days, not the hours, so that late in the evening tomorrow is still tomorrow', () => {
    const lateEvening = new Date(2026, 9, 8, 23, 59);
    const justAfterMidnight = new Date(2026, 9, 8, 0, 1);
    expect(dueText('2026-10-09', lateEvening)).toBe('明天');
    expect(dueText('2026-10-09', justAfterMidnight)).toBe('明天');
  });

  it('counts across the end of a month and of a year', () => {
    expect(dueText('2026-11-01', new Date(2026, 9, 31, 12))).toBe('明天');
    expect(dueText('2027-01-02', new Date(2026, 11, 31, 12))).toBe('2 天后');
  });

  it('shows what it cannot read as it came, instead of a made-up day', () => {
    expect(dueText('someday', now)).toBe('someday');
    expect(dueText('', now)).toBe('');
  });
});

describe('the text of a failed call', () => {
  it('takes the reason the backend sends as a plain string as it is', () => {
    expect(errorText('database is locked')).toBe('database is locked');
  });

  it('takes the message of an Error, without the name of its class in front', () => {
    expect(errorText(new Error('disk is read-only'))).toBe('disk is read-only');
    expect(errorText(new TypeError('x is not a function'))).toBe('x is not a function');
  });

  it('still says something for anything else', () => {
    expect(errorText(42)).toBe('42');
    expect(errorText(null)).toBe('null');
    expect(errorText(undefined)).toBe('undefined');
  });
});
