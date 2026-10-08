import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LexNoteProvider } from '../../contexts/LexNoteContext';
import * as bridge from '../../lib/tauri-bridge';
import { EnrichmentSection } from './EnrichmentSection';

vi.mock('../../lib/tauri-bridge', () => ({
  isTauri: () => true,
  getAllWords: vi.fn(),
  getSettings: vi.fn(),
  getTemplates: vi.fn(),
  getUsage: vi.fn(),
  getStartupWarnings: vi.fn(),
  saveSettings: vi.fn(),
  listenLookupDone: vi.fn(),
  listenLookupError: vi.fn(),
  listenLookupDelta: vi.fn(),
}));

const MAIN = { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: '••••••••' };

function stubSettings(settings: Record<string, unknown>) {
  vi.mocked(bridge.getSettings).mockResolvedValue({ provider: MAIN, ...settings } as never);
}

function renderSection() {
  return render(
    <LexNoteProvider>
      <EnrichmentSection />
    </LexNoteProvider>,
  );
}

const limit = () => screen.getByLabelText('每天最多用') as HTMLSelectElement;
const pace = () => screen.getByLabelText('请求节奏') as HTMLSelectElement;

describe('the settings of the batch enrichment', () => {
  beforeEach(() => {
    vi.mocked(bridge.getAllWords).mockResolvedValue([]);
    vi.mocked(bridge.getTemplates).mockResolvedValue([]);
    vi.mocked(bridge.getUsage).mockResolvedValue({ today: 0, month: 0, tokens: 0 });
    vi.mocked(bridge.getStartupWarnings).mockResolvedValue([]);
    vi.mocked(bridge.saveSettings).mockResolvedValue(undefined);
    vi.mocked(bridge.listenLookupDone).mockResolvedValue(() => undefined);
    vi.mocked(bridge.listenLookupError).mockResolvedValue(() => undefined);
    vi.mocked(bridge.listenLookupDelta).mockResolvedValue(() => undefined);
    stubSettings({});
  });

  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  it('starts from the recommended limit and the standard pace, and says what is and is not touched', async () => {
    renderSection();

    await waitFor(() => expect(limit()).toHaveDisplayValue('10 万 tokens（约 60 个词，推荐）'));
    expect(pace()).toHaveDisplayValue('标准（每 3 秒一个词，推荐）');
    const section = screen.getByRole('heading', { name: '批量补全' }).closest('section') as HTMLElement;
    expect(section).toHaveTextContent('不会覆盖你写的释义、笔记、标签和复习进度');
    expect(section).toHaveTextContent('主模型出问题时也会像查词一样改用备用模型');
    expect(section).toHaveTextContent('是估算值，不是服务商的账单');
  });

  it('offers the limits, and no limit at all as the last of them', () => {
    renderSection();

    const labels = Array.from(limit().options).map((option) => option.text);
    expect(labels).toEqual([
      '5 万 tokens（约 30 个词）',
      '10 万 tokens（约 60 个词，推荐）',
      '30 万 tokens（约 200 个词）',
      '100 万 tokens（约 650 个词）',
      '不限制',
    ]);
  });

  it('saves the limit that was chosen, and zero for no limit', async () => {
    renderSection();
    await waitFor(() => expect(limit()).toHaveDisplayValue('10 万 tokens（约 60 个词，推荐）'));

    await userEvent.selectOptions(limit(), '300000');
    await waitFor(() =>
      expect(bridge.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ enrichDailyTokens: 300_000 })),
    );
    expect(limit()).toHaveDisplayValue('30 万 tokens（约 200 个词）');

    await userEvent.selectOptions(limit(), '不限制');
    await waitFor(() =>
      expect(bridge.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ enrichDailyTokens: 0 })),
    );
  });

  it('saves the pace that was chosen', async () => {
    renderSection();
    await waitFor(() => expect(pace()).toHaveDisplayValue('标准（每 3 秒一个词，推荐）'));

    await userEvent.selectOptions(pace(), 'gentle');

    await waitFor(() =>
      expect(bridge.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ enrichPace: 'gentle' })),
    );
    expect(pace()).toHaveDisplayValue('从容（每 6 秒一个词）');
  });

  it('shows the choices that were saved earlier', async () => {
    stubSettings({ enrichDailyTokens: 0, enrichPace: 'fast' });

    renderSection();

    await waitFor(() => expect(limit()).toHaveDisplayValue('不限制'));
    expect(pace()).toHaveDisplayValue('较快（每 1.5 秒一个词，容易被限流）');
  });

  it('shows a limit that was written into the settings by hand as it is, as one more choice', async () => {
    stubSettings({ enrichDailyTokens: 250_000 });

    renderSection();

    await waitFor(() => expect(limit()).toHaveDisplayValue('250,000 tokens（自定义）'));
    expect(limit().options).toHaveLength(6);
  });

  it('shows what the backend would really go by when what was saved makes no sense', async () => {
    stubSettings({ enrichDailyTokens: 12, enrichPace: 'turbo' });

    renderSection();

    await waitFor(() => expect(limit()).toHaveDisplayValue('10 万 tokens（约 60 个词，推荐）'));
    expect(pace()).toHaveDisplayValue('标准（每 3 秒一个词，推荐）');
    expect(limit().options).toHaveLength(5);
  });
});
