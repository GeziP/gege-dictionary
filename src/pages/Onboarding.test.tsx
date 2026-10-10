import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LexNoteProvider } from '../contexts/LexNoteContext';
import * as bridge from '../lib/tauri-bridge';
import { Onboarding } from './Onboarding';

vi.mock('../lib/tauri-bridge', () => ({
  isTauri: () => true,
  getAllWords: vi.fn().mockResolvedValue([]),
  getSettings: vi.fn().mockResolvedValue({}),
  getTemplates: vi.fn().mockResolvedValue([]),
  getUsage: vi.fn().mockResolvedValue({ today: 0, month: 0, tokens: 0 }),
  getStartupWarnings: vi.fn().mockResolvedValue([]),
  listenLookupDone: vi.fn().mockResolvedValue(() => undefined),
  listenLookupError: vi.fn().mockResolvedValue(() => undefined),
  listenLookupDelta: vi.fn().mockResolvedValue(() => undefined),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  testConnection: vi.fn().mockResolvedValue({ ok: true, latency: 120, model: 'test-model' }),
  getAutostartStatus: vi.fn().mockResolvedValue(false),
  setAutostart: vi.fn().mockResolvedValue(false),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const clickFooterNext = async () => {
  const buttons = screen.getAllByRole('button');
  await userEvent.click(buttons[buttons.length - 1]);
};

const clickConnectionTest = async () => {
  const buttons = screen.getAllByRole('button');
  await userEvent.click(buttons[buttons.length - 2]);
  await waitFor(() => expect(bridge.testConnection).toHaveBeenCalled());
};

const renderOnboarding = () => render(
  <MemoryRouter>
    <LexNoteProvider>
      <Onboarding />
    </LexNoteProvider>
  </MemoryRouter>,
);

describe('onboarding autostart', () => {
  it('keeps the toggle off and shows an error when the OS registration fails', async () => {
    vi.mocked(bridge.setAutostart).mockRejectedValueOnce(new Error('permission denied'));
    renderOnboarding();
    await clickConnectionTest();
    await clickFooterNext();
    await clickFooterNext();

    const autostart = screen.getAllByRole('switch')[0];
    expect(autostart).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(autostart);

    await waitFor(() => expect(screen.getByText(/permission denied/)).toBeInTheDocument());
    expect(autostart).toHaveAttribute('aria-checked', 'false');
    expect(bridge.setAutostart).toHaveBeenCalledWith(true);
  });

  it('shows the operating system autostart state on first render', async () => {
    vi.mocked(bridge.getAutostartStatus).mockResolvedValueOnce(true);
    renderOnboarding();
    await clickConnectionTest();
    await clickFooterNext();
    await clickFooterNext();

    const autostart = screen.getAllByRole('switch')[0];
    await waitFor(() => expect(autostart).toHaveAttribute('aria-checked', 'true'));
    expect(bridge.getAutostartStatus).toHaveBeenCalled();
  });
});

describe('onboarding connection test', () => {
  it('reports the latency and model the backend measured and then lets the user continue', async () => {
    vi.mocked(bridge.testConnection).mockResolvedValueOnce({ ok: true, latency: 87, model: 'deepseek-chat' });
    renderOnboarding();
    expect(screen.getByRole('button', { name: '请先测试连接' })).toBeDisabled();

    await clickConnectionTest();

    await waitFor(() => expect(screen.getByText(/连接正常 · 87ms · 模型回显 deepseek-chat/)).toBeInTheDocument());
    expect(screen.queryByText(/412ms/)).toBeNull();
    expect(screen.getByRole('button', { name: '下一步' })).toBeEnabled();
  });

  it('says why a test failed instead of always blaming the API key, and keeps the user on this step', async () => {
    vi.mocked(bridge.testConnection).mockRejectedValueOnce('[network] 无法连接到模型服务，请检查 Base URL 是否正确');
    renderOnboarding();

    await clickConnectionTest();

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('无法连接到模型服务，请检查 Base URL 是否正确'),
    );
    expect(screen.queryByText(/鉴权失败（401）/)).toBeNull();
    expect(screen.getByRole('alert')).not.toHaveTextContent('[network]');
    expect(screen.getByRole('button', { name: '请先测试连接' })).toBeDisabled();
  });

  it('forgets a passed test as soon as the key is edited', async () => {
    renderOnboarding();
    await clickConnectionTest();
    await waitFor(() => expect(screen.getByText(/连接正常/)).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText('sk-…'), 'x');

    await waitFor(() => expect(screen.queryByText(/连接正常/)).toBeNull());
    expect(screen.getByRole('button', { name: '请先测试连接' })).toBeDisabled();
  });
});

describe('onboarding model presets', () => {
  const keyLink = () => screen.queryByRole('link', { name: /如何获取/ });
  const keyBox = () => screen.getByPlaceholderText('sk-…');

  it('leads to the page where the key of the chosen service is made, and to no page before one is chosen', async () => {
    renderOnboarding();
    expect(keyLink()).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'DeepSeek' }));
    expect(keyLink()).toHaveAttribute('href', 'https://platform.deepseek.com');
    expect(keyLink()).toHaveAttribute('target', '_blank');

    await userEvent.click(screen.getByRole('button', { name: 'OpenAI' }));
    expect(keyLink()).toHaveAttribute('href', 'https://platform.openai.com/api-keys');
  });

  it('lets the local gateway be used at once: it has no page for a key, and a placeholder in its place', async () => {
    renderOnboarding();

    await userEvent.click(screen.getByRole('button', { name: '本地网关' }));

    expect(keyLink()).not.toBeInTheDocument();
    expect(screen.getByText('这个服务不校验 Key，已填入占位符，保持原样即可')).toBeInTheDocument();
    expect(keyBox()).toHaveValue('ollama');

    await clickConnectionTest();
    expect(vi.mocked(bridge.testConnection).mock.calls[0].slice(0, 4)).toEqual([
      'http://127.0.0.1:11434/v1',
      'ollama',
      'qwen2.5:14b',
      'openai',
    ]);
    expect(await screen.findByRole('button', { name: '下一步' })).toBeEnabled();
  });

  it('does not put the placeholder over a key that was typed', async () => {
    renderOnboarding();
    await userEvent.type(keyBox(), 'sk-mine');

    await userEvent.click(screen.getByRole('button', { name: '本地网关' }));

    expect(keyBox()).toHaveValue('sk-mine');
  });

  it('takes the placeholder out again when a service that needs a real key is chosen next', async () => {
    renderOnboarding();
    await userEvent.click(screen.getByRole('button', { name: '本地网关' }));
    expect(keyBox()).toHaveValue('ollama');

    await userEvent.click(screen.getByRole('button', { name: 'Kimi' }));

    expect(keyBox()).toHaveValue('');
    expect(keyLink()).toHaveAttribute('href', 'https://platform.moonshot.cn');
  });
});