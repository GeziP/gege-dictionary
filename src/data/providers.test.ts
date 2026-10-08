import { describe, expect, it } from 'vitest';
import { NO_KEY_PLACEHOLDER, PROVIDER_PRESETS, presetChanges, presetOf } from './providers';

const preset = (id: string) => {
  const found = PROVIDER_PRESETS.find((item) => item.id === id);
  if (!found) throw new Error(`no preset ${id}`);
  return found;
};

describe('the presets of model services', () => {
  it('send the user to a real page to make a key, and to none for the service that asks for no key', () => {
    for (const item of PROVIDER_PRESETS) {
      if (item.keyUrl === null) continue;
      expect(item.keyUrl, item.name).toMatch(/^https:\/\//);
    }
    expect(preset('local').keyUrl).toBeNull();
    expect(PROVIDER_PRESETS.filter((item) => item.keyUrl === null).map((item) => item.id)).toEqual(['local']);
  });

  it('have a Base URL each, so that one can tell which is chosen', () => {
    const urls = PROVIDER_PRESETS.map((item) => item.baseUrl);
    expect(new Set(urls).size).toBe(urls.length);
    expect(presetOf('https://api.deepseek.com')?.id).toBe('deepseek');
    expect(presetOf('http://127.0.0.1:11434/v1')?.id).toBe('local');
    expect(presetOf('https://example.com/v1')).toBeUndefined();
    expect(presetOf('')).toBeUndefined();
    expect(presetOf('   ')).toBeUndefined();
  });

  it('are recognised by the address of the service, however it was written', () => {
    expect(presetOf('https://api.deepseek.com/')?.id).toBe('deepseek');
    expect(presetOf('https://api.deepseek.com/v1')?.id).toBe('deepseek');
    expect(presetOf('  HTTPS://API.OPENAI.COM/V1/  ')?.id).toBe('openai');
    expect(presetOf('https://api.openai.com')?.id).toBe('openai');
    expect(presetOf('http://127.0.0.1:11434')?.id).toBe('local');
  });

  it('are not taken for each other, or for an address that only looks like one', () => {
    for (const item of PROVIDER_PRESETS) expect(presetOf(item.baseUrl)?.id, item.name).toBe(item.id);
    expect(presetOf('https://api.deepseek.com.proxy.example')).toBeUndefined();
    expect(presetOf('https://proxy.example/api.deepseek.com')).toBeUndefined();
    expect(presetOf('https://api.deepseek.com/v2')).toBeUndefined();
  });
});

describe('choosing a preset', () => {
  it('sets the name, the protocol, the address and the model, and leaves the key alone', () => {
    const changes = presetChanges(preset('deepseek'), { apiKey: 'sk-mine', hasApiKey: true });
    expect(changes).toEqual({
      name: 'DeepSeek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    });
    expect(changes).not.toHaveProperty('apiKey');
  });

  it('gives the local gateway a placeholder key, since the app does not look anything up without one', () => {
    const changes = presetChanges(preset('local'), { apiKey: '', hasApiKey: false });
    expect(changes.apiKey).toBe(NO_KEY_PLACEHOLDER);
    expect(changes.baseUrl).toBe('http://127.0.0.1:11434/v1');
  });

  it('does not put the placeholder over a key the user has typed or has stored', () => {
    expect(presetChanges(preset('local'), { apiKey: 'sk-mine', hasApiKey: false })).not.toHaveProperty('apiKey');
    expect(presetChanges(preset('local'), { apiKey: '', hasApiKey: true })).not.toHaveProperty('apiKey');
  });

  it('takes the placeholder out again when a service that needs a real key is chosen after the local gateway', () => {
    const changes = presetChanges(preset('deepseek'), { apiKey: NO_KEY_PLACEHOLDER, hasApiKey: false });

    expect(changes.apiKey).toBe('');
    expect(changes.baseUrl).toBe('https://api.deepseek.com');
  });

  it('never hands a service that needs a key the placeholder', () => {
    for (const item of PROVIDER_PRESETS.filter((candidate) => candidate.keyUrl !== null)) {
      expect(presetChanges(item, { apiKey: '', hasApiKey: false }), item.name).not.toHaveProperty('apiKey');
    }
  });
});
