import { describe, expect, it } from 'vitest';
import { installedVoiceFor, voiceLabel } from './voices';

const INSTALLED = ['Microsoft Huihui Desktop', 'Microsoft Zira Desktop', 'Microsoft David Desktop'];

describe('installedVoiceFor', () => {
  it('finds the voice a part of whose name was saved, as the speech engine does', () => {
    expect(installedVoiceFor('Microsoft Zira', INSTALLED)).toBe('Microsoft Zira Desktop');
    expect(installedVoiceFor('david', INSTALLED)).toBe('Microsoft David Desktop');
  });

  it('knows a voice by its full name', () => {
    expect(installedVoiceFor('Microsoft Huihui Desktop', INSTALLED)).toBe('Microsoft Huihui Desktop');
  });

  it('is empty for a voice that is not installed, so the list does not claim one that will not be used', () => {
    expect(installedVoiceFor('Microsoft Hazel - English (United Kingdom)', INSTALLED)).toBe('');
    expect(installedVoiceFor('Microsoft Zira', [])).toBe('');
  });

  it('is empty when no voice was chosen', () => {
    expect(installedVoiceFor('', INSTALLED)).toBe('');
    expect(installedVoiceFor('   ', INSTALLED)).toBe('');
  });

  it('takes the first of several matches, in the order the engine lists them', () => {
    expect(installedVoiceFor('microsoft', INSTALLED)).toBe('Microsoft Huihui Desktop');
  });
});

describe('voiceLabel', () => {
  it('drops the vendor that every entry starts with', () => {
    expect(voiceLabel('Microsoft Zira Desktop')).toBe('Zira Desktop');
  });

  it('leaves other names alone', () => {
    expect(voiceLabel('eSpeak English')).toBe('eSpeak English');
  });
});
