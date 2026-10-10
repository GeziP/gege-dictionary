import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER, NO_KEY_NOTE, NO_KEY_PLACEHOLDER } from '../../data/providers';
import type { ProviderConfig } from '../../types/lexnote';
import { ProviderFields } from './ProviderFields';

function show(overrides: Partial<ProviderConfig> = {}) {
  const onChange = vi.fn();
  render(<ProviderFields provider={{ ...DEFAULT_PROVIDER, ...overrides }} onChange={onChange} />);
  return onChange;
}

const howTo = () => screen.queryByRole('link', { name: /如何获取/ });

describe('the fields of a model service', () => {
  afterEach(() => {
    cleanup();
  });

  describe('the page where the key is made', () => {
    it('is linked for each service the app has a preset for, and opens beside the app', () => {
      show({ baseUrl: 'https://api.deepseek.com' });

      expect(howTo()).toHaveAttribute('href', 'https://platform.deepseek.com');
      expect(howTo()).toHaveAttribute('target', '_blank');
      expect(howTo()).toHaveAttribute('rel', 'noreferrer');
    });

    it('is the page of the service whose Base URL it is, not of the first one', () => {
      show({ baseUrl: 'https://api.openai.com/v1' });

      expect(howTo()).toHaveAttribute('href', 'https://platform.openai.com/api-keys');
    });

    it('is not guessed for a Base URL that is not a preset', () => {
      show({ baseUrl: 'https://llm.example.com/v1' });

      expect(howTo()).not.toBeInTheDocument();
      expect(screen.queryByText(/这个服务不校验 Key/)).not.toBeInTheDocument();
    });

    it('is not there for the local gateway, which says instead that any key will do', () => {
      show({ baseUrl: 'http://127.0.0.1:11434/v1' });

      expect(howTo()).not.toBeInTheDocument();
      expect(screen.getByText(NO_KEY_NOTE)).toBeInTheDocument();
    });
  });

  describe('choosing a preset', () => {
    it('sets the service and the model, and touches no key that is there', async () => {
      const onChange = show({ apiKey: 'sk-mine' });

      await userEvent.click(screen.getByRole('button', { name: 'DeepSeek' }));

      expect(onChange).toHaveBeenCalledWith({
        name: 'DeepSeek',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
      });
    });

    it('lets the local gateway be used at once, with a placeholder where no key was ever given', async () => {
      const onChange = show();

      await userEvent.click(screen.getByRole('button', { name: '本地网关' }));

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: NO_KEY_PLACEHOLDER }),
      );
    });

    it('does not take the key the user has stored for the placeholder', async () => {
      const onChange = show({ hasApiKey: true });

      await userEvent.click(screen.getByRole('button', { name: '本地网关' }));

      expect(onChange.mock.calls[0][0]).not.toHaveProperty('apiKey');
    });

    it('takes the placeholder back out when a service that needs a real key is chosen after the local gateway', async () => {
      const onChange = show({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: NO_KEY_PLACEHOLDER });

      await userEvent.click(screen.getByRole('button', { name: 'DeepSeek' }));

      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://api.deepseek.com', apiKey: '' }));
    });

    it('marks the preset that is in use', () => {
      show({ baseUrl: 'https://api.deepseek.com' });

      expect(screen.getByRole('button', { name: 'DeepSeek' })).toHaveClass('border-accent');
      expect(screen.getByRole('button', { name: 'Kimi' })).not.toHaveClass('border-accent');
    });

    it('marks it, and points to its key page, also when the address was written another way', () => {
      show({ baseUrl: 'https://api.deepseek.com/v1/' });

      expect(screen.getByRole('button', { name: 'DeepSeek' })).toHaveClass('border-accent');
      expect(howTo()).toHaveAttribute('href', 'https://platform.deepseek.com');
    });

    it('marks none when the address is not one of theirs', () => {
      show({ baseUrl: 'https://llm.example.com/v1' });

      for (const name of ['OpenAI', 'DeepSeek', 'Kimi', '本地网关']) {
        expect(screen.getByRole('button', { name })).not.toHaveClass('border-accent');
      }
    });
  });

  describe('the Base URL', () => {
    it('takes the protocol of a preset when its address is typed in whole', async () => {
      const onChange = show();
      await userEvent.click(screen.getByLabelText('Base URL'));

      // Pasted whole: typed letter by letter, the box passes through addresses that are not presets.
      await userEvent.paste('https://api.anthropic.com');

      expect(onChange).toHaveBeenLastCalledWith({ baseUrl: 'https://api.anthropic.com', protocol: 'anthropic' });
    });

    it('guesses the protocol of an address that is not a preset from what is in it', async () => {
      const onChange = show();
      await userEvent.click(screen.getByLabelText('Base URL'));

      await userEvent.paste('https://proxy.example.com/anthropic');
      expect(onChange).toHaveBeenLastCalledWith({
        baseUrl: 'https://proxy.example.com/anthropic',
        protocol: 'anthropic',
      });

      await userEvent.paste('https://proxy.example.com/v1');
      expect(onChange).toHaveBeenLastCalledWith({ baseUrl: 'https://proxy.example.com/v1', protocol: 'openai' });
    });
  });

  describe('the key', () => {
    it('is never shown once it is stored, and can be replaced', async () => {
      const onChange = show({ hasApiKey: true });
      expect(screen.getByText('已配置')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: '更换 Key' }));

      expect(onChange).toHaveBeenCalledWith({ apiKey: '', hasApiKey: false });
    });

    it('is typed into at once after "更换 Key", without another click in the box', async () => {
      show({ hasApiKey: true });

      await userEvent.click(screen.getByRole('button', { name: '更换 Key' }));

      expect(screen.getByLabelText('API Key')).toHaveFocus();
      expect(screen.queryByText('已配置')).not.toBeInTheDocument();
    });

    it('is named by its caption, also while a stored key is shown beside it', () => {
      show({ hasApiKey: true });

      expect(screen.getByLabelText('API Key')).toHaveAttribute('type', 'password');
      expect(screen.getByRole('button', { name: '更换 Key' })).toBeInTheDocument();
    });

    it('is reached by a click on the caption, which does not replace the stored key', async () => {
      const onChange = show({ hasApiKey: true });

      await userEvent.click(screen.getByText('API Key'));

      expect(screen.getByLabelText('API Key')).toHaveFocus();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('is not replaced by a click on the words about how it is kept', async () => {
      const onChange = show({ hasApiKey: true });

      await userEvent.click(screen.getByText(/经 Windows DPAPI 加密后存储/));

      expect(onChange).not.toHaveBeenCalled();
    });

    it('says why a stored key could not be used', () => {
      render(<ProviderFields provider={DEFAULT_PROVIDER} onChange={vi.fn()} keyError="无法解密已保存的 Key" />);

      expect(screen.getByText('无法解密已保存的 Key')).toBeInTheDocument();
    });
  });
});
