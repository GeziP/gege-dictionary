import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LexNoteProvider } from '../../contexts/LexNoteContext';
import * as bridge from '../../lib/tauri-bridge';
import { BackupProviderSection } from './BackupProviderSection';
import { ProviderSection } from './ProviderSection';

vi.mock('../../lib/tauri-bridge', () => ({
  isTauri: () => true,
  getAllWords: vi.fn(),
  getSettings: vi.fn(),
  getTemplates: vi.fn(),
  getUsage: vi.fn(),
  getStartupWarnings: vi.fn(),
  saveSettings: vi.fn(),
  testConnection: vi.fn(),
  listenLookupDone: vi.fn(),
  listenLookupError: vi.fn(),
  listenLookupDelta: vi.fn(),
}));

const MAIN = {
  name: 'DeepSeek',
  protocol: 'openai',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  apiKey: '••••••••',
  hasApiKey: true,
  temperature: 0.3,
  maxTokens: 2000,
  timeoutSeconds: 60,
};

const BACKUP = {
  name: 'OpenAI',
  protocol: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '••••••••',
  hasApiKey: true,
  temperature: 0.3,
  maxTokens: 2000,
  timeoutSeconds: 60,
  enabled: true,
};

function stubSettings(settings: Record<string, unknown>) {
  vi.mocked(bridge.getSettings).mockResolvedValue({ provider: MAIN, ...settings } as never);
}

function renderBoth() {
  return render(
    <LexNoteProvider>
      <ProviderSection />
      <BackupProviderSection />
    </LexNoteProvider>,
  );
}

const backupSection = () => screen.getByRole('heading', { name: '备用模型' }).closest('section') as HTMLElement;
const mainSection = () => screen.getByRole('heading', { name: '模型服务' }).closest('section') as HTMLElement;
const backupSwitch = () => screen.getByRole('switch', { name: '启用备用模型' });

describe('the main and the backup model service in the settings', () => {
  beforeEach(() => {
    vi.mocked(bridge.getAllWords).mockResolvedValue([]);
    vi.mocked(bridge.getTemplates).mockResolvedValue([]);
    vi.mocked(bridge.getUsage).mockResolvedValue({ today: 0, month: 0, tokens: 0 });
    vi.mocked(bridge.getStartupWarnings).mockResolvedValue([]);
    vi.mocked(bridge.saveSettings).mockResolvedValue(undefined);
    vi.mocked(bridge.testConnection).mockResolvedValue({ ok: true, latency: 64, model: 'echoed' });
    vi.mocked(bridge.listenLookupDone).mockResolvedValue(() => undefined);
    vi.mocked(bridge.listenLookupError).mockResolvedValue(() => undefined);
    vi.mocked(bridge.listenLookupDelta).mockResolvedValue(() => undefined);
    stubSettings({});
  });

  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  describe('the backup', () => {
    it('is off until it is switched on, and says what it would be sent', async () => {
      renderBoth();
      await within(mainSection()).findByText('已配置');

      expect(backupSwitch()).toHaveAttribute('aria-checked', 'false');
      expect(within(backupSection()).queryByLabelText('Base URL')).not.toBeInTheDocument();
      expect(backupSection()).toHaveTextContent('备用服务会收到与主模型相同的选中文本和上下文');
      expect(backupSection()).toHaveTextContent('Key 无效、模型不存在这类要你去改配置的错误不会触发备用');
    });

    it('is switched on and off with a saved setting, and only then offers its own fields', async () => {
      renderBoth();
      await within(mainSection()).findByText('已配置');

      await userEvent.click(backupSwitch());

      await waitFor(() =>
        expect(bridge.saveSettings).toHaveBeenLastCalledWith(
          expect.objectContaining({ backupProvider: expect.objectContaining({ enabled: true }) }),
        ),
      );
      expect(within(backupSection()).getByLabelText('Base URL')).toBeInTheDocument();
      expect(within(backupSection()).getByLabelText('Model')).toBeInTheDocument();

      await userEvent.click(backupSwitch());
      await waitFor(() =>
        expect(bridge.saveSettings).toHaveBeenLastCalledWith(
          expect.objectContaining({ backupProvider: expect.objectContaining({ enabled: false }) }),
        ),
      );
      expect(within(backupSection()).queryByLabelText('Base URL')).not.toBeInTheDocument();
    });

    it('says what is still missing, until the service, the model and the key are all there', async () => {
      stubSettings({ backupProvider: { enabled: true } });
      renderBoth();

      expect(await within(backupSection()).findByRole('status')).toHaveTextContent(
        '还缺 Base URL、Model、API Key，补全之前备用模型不会生效。',
      );

      await userEvent.click(within(backupSection()).getByLabelText('Base URL'));
      await userEvent.paste('https://api.openai.com/v1');
      await userEvent.click(within(backupSection()).getByLabelText('Model'));
      await userEvent.paste('gpt-4o-mini');
      await waitFor(() =>
        expect(within(backupSection()).getByRole('status')).toHaveTextContent('还缺 API Key，'),
      );

      // This label also carries the note about how the key is stored, so it is matched by its start.
      await userEvent.click(within(backupSection()).getByLabelText(/^API Key/));
      await userEvent.paste('sk-backup');
      await waitFor(() => expect(within(backupSection()).queryByRole('status')).not.toBeInTheDocument());
    });

    it('saves what is typed into the backup, and does not touch the main service', async () => {
      stubSettings({ backupProvider: { ...BACKUP, baseUrl: '', model: '' } });
      renderBoth();
      await within(backupSection()).findByLabelText('Base URL');

      await userEvent.click(within(backupSection()).getByLabelText('Base URL'));
      await userEvent.paste('https://api.anthropic.com');

      await waitFor(() =>
        expect(bridge.saveSettings).toHaveBeenLastCalledWith(
          expect.objectContaining({
            backupProvider: expect.objectContaining({
              baseUrl: 'https://api.anthropic.com',
              protocol: 'anthropic',
            }),
            provider: expect.objectContaining({ baseUrl: MAIN.baseUrl, model: MAIN.model }),
          }),
        ),
      );
    });

    it('shows a stored key as configured, without showing it', async () => {
      stubSettings({ backupProvider: BACKUP });
      renderBoth();

      expect(await within(backupSection()).findByText('已配置')).toBeInTheDocument();
      expect(within(backupSection()).queryByRole('status')).not.toBeInTheDocument();
      expect(within(backupSection()).queryByDisplayValue('••••••••')).not.toBeInTheDocument();
    });

    it('says why a stored key could not be used', async () => {
      stubSettings({
        backupProvider: { ...BACKUP, apiKey: '', hasApiKey: false },
        backupApiKeyError: 'API Key 无法在当前 Windows 用户下解密，请重新配置',
      });
      renderBoth();

      expect(await within(backupSection()).findByText('API Key 无法在当前 Windows 用户下解密，请重新配置')).toBeInTheDocument();
    });

    it('tests the backup service as the backup, with its own settings', async () => {
      stubSettings({ backupProvider: BACKUP });
      renderBoth();
      await within(backupSection()).findByText('已配置');

      await userEvent.click(within(backupSection()).getByRole('button', { name: '测试备用连接' }));

      expect(await within(backupSection()).findByText('连接正常 · 64ms · 模型回显 echoed')).toBeInTheDocument();
      expect(bridge.testConnection).toHaveBeenCalledWith(
        'https://api.openai.com/v1',
        '••••••••',
        'gpt-4o-mini',
        'openai',
        true,
      );
    });

    it('says why the backup test failed', async () => {
      stubSettings({ backupProvider: BACKUP });
      vi.mocked(bridge.testConnection).mockRejectedValue('[auth] 鉴权失败（401）：API Key 无效或已过期');
      renderBoth();
      await within(backupSection()).findByText('已配置');

      await userEvent.click(within(backupSection()).getByRole('button', { name: '测试备用连接' }));

      expect(await within(backupSection()).findByRole('alert')).toHaveTextContent('401');
    });
  });

  describe('the main service', () => {
    it('is still shown with its stored key, and tested as the main service', async () => {
      renderBoth();

      expect(await within(mainSection()).findByText('已配置')).toBeInTheDocument();
      expect(within(mainSection()).getByLabelText('Base URL')).toHaveValue(MAIN.baseUrl);
      expect(within(mainSection()).getByLabelText('Model')).toHaveValue(MAIN.model);

      await userEvent.click(within(mainSection()).getByRole('button', { name: '测试连接' }));

      expect(await within(mainSection()).findByText('连接正常 · 64ms · 模型回显 echoed')).toBeInTheDocument();
      expect(bridge.testConnection).toHaveBeenCalledWith(MAIN.baseUrl, '••••••••', MAIN.model, 'openai', false);
    });

    it('is not changed by what is typed into the backup, and the other way round', async () => {
      stubSettings({ backupProvider: BACKUP });
      renderBoth();
      await within(mainSection()).findByLabelText('Model');

      await userEvent.click(within(mainSection()).getByLabelText('Model'));
      await userEvent.clear(within(mainSection()).getByLabelText('Model'));
      await userEvent.paste('deepseek-v4-pro');

      await waitFor(() =>
        expect(bridge.saveSettings).toHaveBeenLastCalledWith(
          expect.objectContaining({
            provider: expect.objectContaining({ model: 'deepseek-v4-pro' }),
            backupProvider: expect.objectContaining({ model: 'gpt-4o-mini' }),
          }),
        ),
      );
    });
  });
});
